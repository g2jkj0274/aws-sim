'use strict';
const store = require('../store');
const { AwsError, id, now, azs, requireParam, parseCidr, cidrContains, cidrOverlap, intToIp, tagsFromSpec, applyFilters, ACCOUNT_ID } = require('../util');

function S() { return store.get().vpc; }
function E() { return store.get().ec2; }

function findVpc(vpcId) {
  const v = S().vpcs.find((x) => x.VpcId === vpcId);
  if (!v) throw new AwsError('InvalidVpcID.NotFound', `VPC '${vpcId}' 이(가) 존재하지 않습니다.`, 404);
  return v;
}
function findSubnet(subnetId) {
  const s = S().subnets.find((x) => x.SubnetId === subnetId);
  if (!s) throw new AwsError('InvalidSubnetID.NotFound', `서브넷 '${subnetId}' 이(가) 존재하지 않습니다.`, 404);
  return s;
}
function findIgw(igwId) {
  const g = S().igws.find((x) => x.InternetGatewayId === igwId);
  if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `인터넷 게이트웨이 '${igwId}' 이(가) 존재하지 않습니다.`, 404);
  return g;
}
function findRtb(rtbId) {
  const r = S().routeTables.find((x) => x.RouteTableId === rtbId);
  if (!r) throw new AwsError('InvalidRouteTableID.NotFound', `라우팅 테이블 '${rtbId}' 이(가) 존재하지 않습니다.`, 404);
  return r;
}

function createDefaultSg(vpc, region) {
  const sg = {
    GroupId: id('sg'), GroupName: 'default', Description: 'default VPC security group', VpcId: vpc.VpcId, OwnerId: ACCOUNT_ID, Region: region,
    IpPermissions: [{ IpProtocol: '-1', UserIdGroupPairs: [], IpRanges: [], Ipv6Ranges: [], PrefixListIds: [] }],
    IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }], UserIdGroupPairs: [], Ipv6Ranges: [], PrefixListIds: [] }],
    Tags: [],
  };
  sg.IpPermissions[0].UserIdGroupPairs.push({ GroupId: sg.GroupId, UserId: ACCOUNT_ID });
  E().securityGroups.push(sg);
  return sg;
}

function createVpcInternal(cidr, region, tags, isDefault = false) {
  const v = { VpcId: id('vpc'), CidrBlock: cidr, State: 'available', OwnerId: ACCOUNT_ID, InstanceTenancy: 'default', IsDefault: isDefault, DhcpOptionsId: 'dopt-0' + 'a'.repeat(16), Region: region, Tags: tags || [], EnableDnsSupport: true, EnableDnsHostnames: isDefault, CreatedAt: now() };
  S().vpcs.push(v);
  // main route table
  const rtb = { RouteTableId: id('rtb'), VpcId: v.VpcId, Region: region, OwnerId: ACCOUNT_ID, Routes: [{ DestinationCidrBlock: cidr, GatewayId: 'local', Origin: 'CreateRouteTable', State: 'active' }], Associations: [{ RouteTableAssociationId: id('rtbassoc'), RouteTableId: null, Main: true, AssociationState: { State: 'associated' } }], Tags: [] };
  rtb.Associations[0].RouteTableId = rtb.RouteTableId;
  S().routeTables.push(rtb);
  createDefaultSg(v, region);
  return v;
}

function seedRegion(region) {
  if (S().vpcs.find((v) => v.Region === region && v.IsDefault)) return;
  const v = createVpcInternal('172.31.0.0/16', region, [], true);
  const igw = { InternetGatewayId: id('igw'), Region: region, OwnerId: ACCOUNT_ID, Attachments: [{ VpcId: v.VpcId, State: 'available' }], Tags: [] };
  S().igws.push(igw);
  const rtb = S().routeTables.find((r) => r.VpcId === v.VpcId);
  rtb.Routes.push({ DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw.InternetGatewayId, Origin: 'CreateRoute', State: 'active' });
  azs(region).slice(0, 2).forEach((az, i) => {
    S().subnets.push({ SubnetId: id('subnet'), VpcId: v.VpcId, CidrBlock: `172.31.${i * 16}.0/20`, AvailabilityZone: az, AvailabilityZoneId: az.replace(/\w$/, (c) => '-az' + (c.charCodeAt(0) - 96)), State: 'available', AvailableIpAddressCount: 4091, MapPublicIpOnLaunch: true, DefaultForAz: true, OwnerId: ACCOUNT_ID, Region: region, Tags: [] });
  });
}

// 주어진 서브넷에 연결된 라우팅 테이블(명시적 연결 → 없으면 메인)
function routeTableForSubnet(subnet) {
  const rts = S().routeTables.filter((r) => r.VpcId === subnet.VpcId);
  return rts.find((r) => r.Associations.some((a) => a.SubnetId === subnet.SubnetId)) || rts.find((r) => r.Associations.some((a) => a.Main));
}
function subnetIsPublic(subnet) {
  const rtb = routeTableForSubnet(subnet);
  if (!rtb) return false;
  return rtb.Routes.some((r) => r.DestinationCidrBlock === '0.0.0.0/0' && /^igw-/.test(r.GatewayId || '') && S().igws.some((g) => g.InternetGatewayId === r.GatewayId && g.Attachments.some((a) => a.VpcId === subnet.VpcId)));
}
function allocateIp(subnet) {
  const { base, size } = parseCidr(subnet.CidrBlock);
  const used = new Set(E().instances.filter((i) => i.SubnetId === subnet.SubnetId && i.State.Name !== 'terminated').map((i) => i.PrivateIpAddress));
  for (let off = 4; off < size - 1; off++) {
    const ip = intToIp(base + off);
    if (!used.has(ip)) return ip;
  }
  throw new AwsError('InsufficientFreeAddressesInSubnet', '서브넷에 사용 가능한 IP 주소가 없습니다.');
}

const actions = {
  CreateVpc(p, ctx) {
    const cidr = requireParam(p, 'CidrBlock');
    const c = parseCidr(cidr);
    if (c.bits < 16 || c.bits > 28) throw new AwsError('InvalidVpc.Range', 'VPC CIDR 블록 크기는 /16 ~ /28 이어야 합니다.');
    const tags = tagsFromSpec(p, 'vpc');
    return { Vpc: createVpcInternal(cidr, ctx.region, tags) };
  },
  DescribeVpcs(p, ctx) {
    let list = S().vpcs.filter((v) => v.Region === ctx.region);
    if (p.VpcIds && p.VpcIds.length) list = list.filter((v) => p.VpcIds.includes(v.VpcId));
    return { Vpcs: applyFilters(list, p.Filters).map((v) => ({ ...v, CidrBlockAssociationSet: [{ CidrBlock: v.CidrBlock, CidrBlockState: { State: 'associated' } }] })) };
  },
  ModifyVpcAttribute(p) {
    const v = findVpc(requireParam(p, 'VpcId'));
    if (p.EnableDnsHostnames) v.EnableDnsHostnames = !!p.EnableDnsHostnames.Value;
    if (p.EnableDnsSupport) v.EnableDnsSupport = !!p.EnableDnsSupport.Value;
    return {};
  },
  DeleteVpc(p) {
    const v = findVpc(requireParam(p, 'VpcId'));
    if (v.IsDefault) throw new AwsError('OperationNotPermitted', '기본 VPC는 이 시뮬레이터에서 삭제할 수 없습니다.');
    if (S().subnets.some((s) => s.VpcId === v.VpcId)) throw new AwsError('DependencyViolation', '서브넷이 남아 있는 VPC는 삭제할 수 없습니다. 먼저 서브넷을 삭제하세요.');
    if (S().igws.some((g) => g.Attachments.some((a) => a.VpcId === v.VpcId))) throw new AwsError('DependencyViolation', '인터넷 게이트웨이가 연결되어 있습니다. 먼저 분리하세요.');
    if (E().securityGroups.some((g) => g.VpcId === v.VpcId && g.GroupName !== 'default')) throw new AwsError('DependencyViolation', '보안 그룹이 남아 있습니다. 먼저 삭제하세요.');
    S().routeTables = S().routeTables.filter((r) => r.VpcId !== v.VpcId);
    E().securityGroups = E().securityGroups.filter((g) => g.VpcId !== v.VpcId);
    S().vpcs = S().vpcs.filter((x) => x !== v);
    return {};
  },
  CreateSubnet(p, ctx) {
    const v = findVpc(requireParam(p, 'VpcId'));
    const cidr = requireParam(p, 'CidrBlock');
    const c = parseCidr(cidr);
    if (c.bits < 16 || c.bits > 28) throw new AwsError('InvalidSubnet.Range', '서브넷 CIDR 블록 크기는 /16 ~ /28 이어야 합니다.');
    if (!cidrContains(v.CidrBlock, cidr)) throw new AwsError('InvalidSubnet.Range', `서브넷 CIDR ${cidr} 은(는) VPC CIDR ${v.CidrBlock} 범위 안에 있어야 합니다.`);
    const conflict = S().subnets.find((s) => s.VpcId === v.VpcId && cidrOverlap(s.CidrBlock, cidr));
    if (conflict) throw new AwsError('InvalidSubnet.Conflict', `CIDR ${cidr} 이(가) 기존 서브넷 ${conflict.SubnetId}(${conflict.CidrBlock}) 과 겹칩니다.`);
    const az = p.AvailabilityZone || azs(ctx.region)[0];
    if (!azs(ctx.region).includes(az)) throw new AwsError('InvalidParameterValue', `리전 ${ctx.region} 에 존재하지 않는 가용 영역입니다: ${az}`);
    const s = { SubnetId: id('subnet'), VpcId: v.VpcId, CidrBlock: cidr, AvailabilityZone: az, AvailabilityZoneId: az.replace(/\w$/, (ch) => '-az' + (ch.charCodeAt(0) - 96)), State: 'available', AvailableIpAddressCount: c.size - 5, MapPublicIpOnLaunch: false, DefaultForAz: false, OwnerId: ACCOUNT_ID, Region: ctx.region, Tags: tagsFromSpec(p, 'subnet') };
    S().subnets.push(s);
    return { Subnet: s };
  },
  DescribeSubnets(p, ctx) {
    let list = S().subnets.filter((s) => s.Region === ctx.region);
    if (p.SubnetIds && p.SubnetIds.length) list = list.filter((s) => p.SubnetIds.includes(s.SubnetId));
    return { Subnets: applyFilters(list, p.Filters).map((s) => ({ ...s, IsPublic: subnetIsPublic(s) })) };
  },
  ModifySubnetAttribute(p) {
    const s = findSubnet(requireParam(p, 'SubnetId'));
    if (p.MapPublicIpOnLaunch) s.MapPublicIpOnLaunch = !!p.MapPublicIpOnLaunch.Value;
    return {};
  },
  DeleteSubnet(p) {
    const s = findSubnet(requireParam(p, 'SubnetId'));
    if (E().instances.some((i) => i.SubnetId === s.SubnetId && i.State.Name !== 'terminated')) throw new AwsError('DependencyViolation', '인스턴스가 있는 서브넷은 삭제할 수 없습니다.');
    for (const r of S().routeTables) r.Associations = r.Associations.filter((a) => a.SubnetId !== s.SubnetId);
    S().subnets = S().subnets.filter((x) => x !== s);
    return {};
  },
  CreateInternetGateway(p, ctx) {
    const g = { InternetGatewayId: id('igw'), Region: ctx.region, OwnerId: ACCOUNT_ID, Attachments: [], Tags: tagsFromSpec(p, 'internet-gateway') };
    S().igws.push(g);
    return { InternetGateway: g };
  },
  DescribeInternetGateways(p, ctx) {
    let list = S().igws.filter((g) => g.Region === ctx.region);
    if (p.InternetGatewayIds && p.InternetGatewayIds.length) list = list.filter((g) => p.InternetGatewayIds.includes(g.InternetGatewayId));
    return { InternetGateways: applyFilters(list, p.Filters) };
  },
  AttachInternetGateway(p) {
    const g = findIgw(requireParam(p, 'InternetGatewayId'));
    const v = findVpc(requireParam(p, 'VpcId'));
    if (g.Attachments.length) throw new AwsError('Resource.AlreadyAssociated', '이 인터넷 게이트웨이는 이미 VPC에 연결되어 있습니다.');
    if (S().igws.some((x) => x.Attachments.some((a) => a.VpcId === v.VpcId))) throw new AwsError('InvalidParameterValue', 'VPC에는 인터넷 게이트웨이를 하나만 연결할 수 있습니다.');
    g.Attachments.push({ VpcId: v.VpcId, State: 'available' });
    return {};
  },
  DetachInternetGateway(p) {
    const g = findIgw(requireParam(p, 'InternetGatewayId'));
    const vpcId = requireParam(p, 'VpcId');
    if (E().instances.some((i) => i.VpcId === vpcId && i.PublicIpAddress && i.State.Name !== 'terminated')) throw new AwsError('DependencyViolation', '퍼블릭 IP를 가진 인스턴스가 있어 분리할 수 없습니다.');
    g.Attachments = g.Attachments.filter((a) => a.VpcId !== vpcId);
    return {};
  },
  DeleteInternetGateway(p) {
    const g = findIgw(requireParam(p, 'InternetGatewayId'));
    if (g.Attachments.length) throw new AwsError('DependencyViolation', '연결된 인터넷 게이트웨이는 삭제할 수 없습니다. 먼저 분리하세요.');
    S().igws = S().igws.filter((x) => x !== g);
    return {};
  },
  CreateRouteTable(p, ctx) {
    const v = findVpc(requireParam(p, 'VpcId'));
    const rtb = { RouteTableId: id('rtb'), VpcId: v.VpcId, Region: ctx.region, OwnerId: ACCOUNT_ID, Routes: [{ DestinationCidrBlock: v.CidrBlock, GatewayId: 'local', Origin: 'CreateRouteTable', State: 'active' }], Associations: [], Tags: tagsFromSpec(p, 'route-table') };
    S().routeTables.push(rtb);
    return { RouteTable: rtb };
  },
  DescribeRouteTables(p, ctx) {
    let list = S().routeTables.filter((r) => r.Region === ctx.region);
    if (p.RouteTableIds && p.RouteTableIds.length) list = list.filter((r) => p.RouteTableIds.includes(r.RouteTableId));
    return { RouteTables: applyFilters(list, p.Filters) };
  },
  CreateRoute(p) {
    const rtb = findRtb(requireParam(p, 'RouteTableId'));
    const dest = requireParam(p, 'DestinationCidrBlock');
    parseCidr(dest);
    if (rtb.Routes.some((r) => r.DestinationCidrBlock === dest)) throw new AwsError('RouteAlreadyExists', `대상 ${dest} 에 대한 라우팅이 이미 존재합니다.`);
    const route = { DestinationCidrBlock: dest, Origin: 'CreateRoute', State: 'active' };
    if (p.GatewayId) {
      const g = findIgw(p.GatewayId);
      if (!g.Attachments.some((a) => a.VpcId === rtb.VpcId)) throw new AwsError('InvalidParameterValue', `인터넷 게이트웨이 ${p.GatewayId} 이(가) 이 VPC(${rtb.VpcId})에 연결되어 있지 않습니다.`);
      route.GatewayId = p.GatewayId;
    } else if (p.NatGatewayId) {
      const n = S().natGateways.find((x) => x.NatGatewayId === p.NatGatewayId);
      if (!n) throw new AwsError('InvalidNatGatewayID.NotFound', 'NAT 게이트웨이를 찾을 수 없습니다.', 404);
      route.NatGatewayId = p.NatGatewayId;
    } else if (p.InstanceId) {
      route.InstanceId = p.InstanceId;
    } else throw new AwsError('MissingParameter', 'GatewayId, NatGatewayId, InstanceId 중 하나가 필요합니다.');
    rtb.Routes.push(route);
    return { Return: true };
  },
  DeleteRoute(p) {
    const rtb = findRtb(requireParam(p, 'RouteTableId'));
    const dest = requireParam(p, 'DestinationCidrBlock');
    const r = rtb.Routes.find((x) => x.DestinationCidrBlock === dest);
    if (!r) throw new AwsError('InvalidRoute.NotFound', '해당 라우팅이 없습니다.', 404);
    if (r.GatewayId === 'local') throw new AwsError('InvalidParameterValue', 'local 라우팅은 삭제할 수 없습니다.');
    rtb.Routes = rtb.Routes.filter((x) => x !== r);
    return {};
  },
  AssociateRouteTable(p) {
    const rtb = findRtb(requireParam(p, 'RouteTableId'));
    const s = findSubnet(requireParam(p, 'SubnetId'));
    if (s.VpcId !== rtb.VpcId) throw new AwsError('InvalidParameterValue', '서브넷과 라우팅 테이블이 서로 다른 VPC에 있습니다.');
    for (const r of S().routeTables) r.Associations = r.Associations.filter((a) => a.SubnetId !== s.SubnetId);
    const a = { RouteTableAssociationId: id('rtbassoc'), RouteTableId: rtb.RouteTableId, SubnetId: s.SubnetId, Main: false, AssociationState: { State: 'associated' } };
    rtb.Associations.push(a);
    return { AssociationId: a.RouteTableAssociationId, AssociationState: a.AssociationState };
  },
  DisassociateRouteTable(p) {
    const aid = requireParam(p, 'AssociationId');
    for (const r of S().routeTables) r.Associations = r.Associations.filter((a) => a.RouteTableAssociationId !== aid || a.Main);
    return {};
  },
  DeleteRouteTable(p) {
    const rtb = findRtb(requireParam(p, 'RouteTableId'));
    if (rtb.Associations.some((a) => a.Main)) throw new AwsError('DependencyViolation', '메인 라우팅 테이블은 삭제할 수 없습니다.');
    if (rtb.Associations.length) throw new AwsError('DependencyViolation', '서브넷과 연결된 라우팅 테이블은 삭제할 수 없습니다.');
    S().routeTables = S().routeTables.filter((x) => x !== rtb);
    return {};
  },
  CreateNatGateway(p, ctx) {
    const s = findSubnet(requireParam(p, 'SubnetId'));
    const allocId = requireParam(p, 'AllocationId');
    const addr = E().addresses.find((a) => a.AllocationId === allocId);
    if (!addr) throw new AwsError('InvalidAllocationID.NotFound', '탄력적 IP 할당을 찾을 수 없습니다.', 404);
    if (addr.AssociationId) throw new AwsError('Resource.AlreadyAssociated', '이미 사용 중인 탄력적 IP입니다.');
    if (!subnetIsPublic(s)) throw new AwsError('InvalidParameterValue', 'NAT 게이트웨이는 퍼블릭 서브넷(IGW 라우팅이 있는 서브넷)에 만들어야 합니다.');
    const n = { NatGatewayId: id('nat'), SubnetId: s.SubnetId, VpcId: s.VpcId, Region: ctx.region, State: 'pending', ConnectivityType: 'public', NatGatewayAddresses: [{ AllocationId: allocId, PublicIp: addr.PublicIp }], CreateTime: now(), Tags: tagsFromSpec(p, 'natgateway') };
    addr.AssociationId = id('eipassoc'); addr.NatGatewayId = n.NatGatewayId;
    S().natGateways.push(n);
    setTimeout(() => { n.State = 'available'; store.save(); }, 4000);
    return { NatGateway: n };
  },
  DescribeNatGateways(p, ctx) { return { NatGateways: S().natGateways.filter((n) => n.Region === ctx.region) }; },
  DeleteNatGateway(p) {
    const n = S().natGateways.find((x) => x.NatGatewayId === p.NatGatewayId);
    if (!n) throw new AwsError('InvalidNatGatewayID.NotFound', 'NAT 게이트웨이를 찾을 수 없습니다.', 404);
    n.State = 'deleted';
    const addr = E().addresses.find((a) => a.NatGatewayId === n.NatGatewayId);
    if (addr) { delete addr.AssociationId; delete addr.NatGatewayId; }
    S().natGateways = S().natGateways.filter((x) => x !== n);
    return { NatGatewayId: n.NatGatewayId };
  },
  DescribeAvailabilityZones(p, ctx) { return { AvailabilityZones: azs(ctx.region).map((z) => ({ ZoneName: z, RegionName: ctx.region, State: 'available' })) }; },
};

module.exports = { actions, seedRegion, findVpc, findSubnet, subnetIsPublic, routeTableForSubnet, allocateIp };
