'use strict';
const store = require('../store');
const { INSTANCE_TYPES } = require('./ec2');

// 간단한 요금 추정 (us-east-1 온디맨드 기준 근사치)
const PRICES = { ebsGbMonth: 0.08, eipIdleHour: 0.005, natHour: 0.045, s3GbMonth: 0.023, lambdaPerMillion: 0.2, lambdaGbSec: 0.0000166667, ddbWcu: 0.00065, ddbRcu: 0.00013, sqsPerMillion: 0.4, snsPerMillion: 0.5 };

function estimate() {
  const s = store.get();
  const hours = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 3600000);
  const lines = [];
  // EC2
  for (const i of s.ec2.instances) {
    if (['terminated', 'shutting-down'].includes(i.State.Name)) continue;
    const t = INSTANCE_TYPES.find((x) => x.InstanceType === i.InstanceType) || { PriceUsd: 0.05 };
    const h = i.State.Name === 'running' ? hours(i.LaunchTime) : 0;
    lines.push({ Service: 'EC2', Resource: i.InstanceId, Detail: `${i.InstanceType} × ${h.toFixed(2)}h (${i.State.Name})`, HourlyUsd: i.State.Name === 'running' ? t.PriceUsd : 0, MonthlyUsd: i.State.Name === 'running' ? t.PriceUsd * 730 : 0, FreeTier: t.FreeTier });
  }
  for (const v of s.ec2.volumes) lines.push({ Service: 'EBS', Resource: v.VolumeId, Detail: `${v.Size} GiB ${v.VolumeType}`, HourlyUsd: (v.Size * PRICES.ebsGbMonth) / 730, MonthlyUsd: v.Size * PRICES.ebsGbMonth, FreeTier: v.Size <= 30 });
  for (const a of s.ec2.addresses) if (!a.AssociationId) lines.push({ Service: 'EC2', Resource: a.PublicIp, Detail: '연결되지 않은 탄력적 IP (유휴 과금!)', HourlyUsd: PRICES.eipIdleHour, MonthlyUsd: PRICES.eipIdleHour * 730, Warning: true });
  for (const n of s.vpc.natGateways) lines.push({ Service: 'VPC', Resource: n.NatGatewayId, Detail: 'NAT 게이트웨이 (시간당 과금)', HourlyUsd: PRICES.natHour, MonthlyUsd: PRICES.natHour * 730, Warning: true });
  for (const b of s.s3.buckets) { const gb = b.Objects.reduce((x, o) => x + (o.Size || 0), 0) / 1e9; lines.push({ Service: 'S3', Resource: b.Name, Detail: `${(gb * 1024).toFixed(3)} MB 저장`, HourlyUsd: (gb * PRICES.s3GbMonth) / 730, MonthlyUsd: gb * PRICES.s3GbMonth, FreeTier: gb <= 5 }); }
  for (const f of s.lambda.functions) { const inv = f._invocations || 0; lines.push({ Service: 'Lambda', Resource: f.FunctionName, Detail: `${inv}회 호출, ${f.MemorySize}MB`, HourlyUsd: 0, MonthlyUsd: (inv / 1e6) * PRICES.lambdaPerMillion, FreeTier: inv < 1e6 }); }
  for (const t of s.dynamodb.tables) { const prov = t.BillingModeSummary.BillingMode === 'PROVISIONED'; const m = prov ? (t.ProvisionedThroughput.ReadCapacityUnits * PRICES.ddbRcu + t.ProvisionedThroughput.WriteCapacityUnits * PRICES.ddbWcu) * 730 : 0; lines.push({ Service: 'DynamoDB', Resource: t.TableName, Detail: prov ? `프로비저닝 RCU ${t.ProvisionedThroughput.ReadCapacityUnits} / WCU ${t.ProvisionedThroughput.WriteCapacityUnits}` : '온디맨드', HourlyUsd: m / 730, MonthlyUsd: m, FreeTier: !prov || (t.ProvisionedThroughput.ReadCapacityUnits <= 25 && t.ProvisionedThroughput.WriteCapacityUnits <= 25) }); }
  const total = lines.reduce((a, l) => a + l.MonthlyUsd, 0);
  const totalNoFree = lines.filter((l) => !l.FreeTier).reduce((a, l) => a + l.MonthlyUsd, 0);
  return { Currency: 'USD', EstimatedMonthlyUsd: Number(total.toFixed(4)), EstimatedMonthlyUsdBeyondFreeTier: Number(totalNoFree.toFixed(4)), Lines: lines, Note: '시뮬레이터 추정치입니다. 실제 AWS 요금과 다를 수 있습니다.' };
}

const actions = {
  GetCostEstimate() { return estimate(); },
  GetCostAndUsage() { const e = estimate(); const groups = {}; for (const l of e.Lines) groups[l.Service] = (groups[l.Service] || 0) + l.MonthlyUsd; return { ResultsByTime: [{ TimePeriod: { Start: new Date().toISOString().slice(0, 8) + '01', End: new Date().toISOString().slice(0, 10) }, Total: { UnblendedCost: { Amount: e.EstimatedMonthlyUsd.toFixed(2), Unit: 'USD' } }, Groups: Object.entries(groups).map(([k, v]) => ({ Keys: [k], Metrics: { UnblendedCost: { Amount: v.toFixed(4), Unit: 'USD' } } })) }] }; },
};
module.exports = { actions, estimate };
