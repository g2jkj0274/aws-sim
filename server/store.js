'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = process.env.AWSIM_STATE ? path.resolve(process.env.AWSIM_STATE) : path.join(DATA_DIR, 'state.json');

function emptyState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    iam: { users: [], groups: [], roles: [], policies: [], accessKeys: [] },
    ec2: { instances: [], keyPairs: [], securityGroups: [], addresses: [], volumes: [], images: [] },
    vpc: { vpcs: [], subnets: [], igws: [], routeTables: [], natGateways: [] },
    s3: { buckets: [] },
    lambda: { functions: [], eventSourceMappings: [] },
    dynamodb: { tables: [] },
    sqs: { queues: [] },
    sns: { topics: [], subscriptions: [], inbox: [] },
    cloudwatch: { logGroups: [], alarms: [], metrics: [] },
    labs: { completed: {} },
    history: [],
  };
}

let state = null;
let saveTimer = null;

function load(reset = false) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!reset && fs.existsSync(FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const base = emptyState();
      for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
      return state;
    } catch (e) {
      console.warn('state.json 읽기 실패, 새로 시작합니다:', e.message);
    }
  }
  state = emptyState();
  saveNow();
  return state;
}
function get() {
  return state;
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow() {
  saveTimer = null;
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('state 저장 실패:', e.message);
  }
}
function record(entry) {
  state.history.push(entry);
  if (state.history.length > 500) state.history.splice(0, state.history.length - 500);
  save();
}
module.exports = { load, get, save, saveNow, record, FILE };
