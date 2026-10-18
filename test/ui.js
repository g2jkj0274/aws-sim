'use strict';
// 헤드리스 Chrome + CDP 로 콘솔 UI 의 주요 모달 흐름을 클릭해 보는 테스트 (서버가 4566 에 떠 있어야 함)
const { spawn } = require('child_process');
const fs = require('fs');
const BASE = process.env.AWSIM_URL || 'http://127.0.0.1:4566';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome 을 찾지 못해 UI 테스트를 건너뜁니다.'); process.exit(0); }
const PORT = 9333;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
function send(method, params = {}) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }); }
async function evaluate(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception ? r.exceptionDetails.exception.description : JSON.stringify(r.exceptionDetails)).split(String.fromCharCode(10))[0] + ' :: ' + expr.slice(0, 160)); return r.result.value; }
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✔', m); }; const bad = (m) => { fail++; console.log('  ✘', m); };
const assert = (c, m) => (c ? ok(m) : bad(m));
async function dump(label) { console.log('    [' + label + '] hash=' + await evaluate('location.hash') + ' modal=' + JSON.stringify((await evaluate('__modalText()')).slice(0, 300)) + ' content=' + JSON.stringify((await evaluate('__text()')).slice(0, 400))); }
// 페이지 안에서 쓰는 헬퍼
const HELPERS = `
window.__q = (sel, root = document) => root.querySelector(sel);
window.__btn = (text, root = document) => [...root.querySelectorAll('button, a.btn')].find((b) => b.textContent.trim().includes(text));
window.__set = (name, value) => { const w = document.querySelector('[data-field="' + name + '"]'); const el = w.querySelector('input,select,textarea'); if (el.type === 'checkbox') el.checked = !!value; else el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
window.__wait = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); } return null; };
window.__go = async (hash) => { const c = document.querySelector('#content'); c.dataset.route = ''; location.hash = hash; await window.__wait(() => c.dataset.route === hash, 10000); await new Promise((r) => setTimeout(r, 150)); };
window.__text = () => document.querySelector('#content').textContent;
window.__modalText = () => (document.querySelector('.modal') || { textContent: '' }).textContent;
`;
async function main() {
  await sleep(1500);
  if (process.env.AWSIM_UI_RESET !== '0') await fetch(BASE + '/api/reset', { method: 'POST' }); // 깨끗한 상태에서 시작
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/#/' });
  await sleep(2500);
  await evaluate(HELPERS);
  const errors = [];
  await evaluate(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason && e.reason.message || e.reason)));`);

  console.log('\n[S3 버킷 생성 모달]');
  await evaluate(`__go('#/s3')`);
  await evaluate(`__btn('버킷 만들기').click()`);
  assert(await evaluate(`!!__q('.modal')`), '모달 열림');
  await evaluate(`__set('Bucket', 'UI_BAD')`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await sleep(400);
  assert(await evaluate(`__modalText().includes('InvalidBucketName') || __q('.modal .alert.error').textContent.includes('소문자')`), '잘못된 이름 → 모달 안에 오류 표시');
  await evaluate(`__set('Bucket', 'ui-test-bucket'); __set('block', false)`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('ui-test-bucket'))`);
  assert(await evaluate(`location.hash.includes('#/s3/ui-test-bucket')`), '버킷 생성 후 상세로 이동');
  await evaluate(`__wait(() => __btn('업로드'))`);
  await evaluate(`__btn('업로드').click()`);
  await evaluate(`__set('Key', 'index.html'); __set('Body', '<h1>UI</h1>'); __set('ContentType', 'text/html')`);
  await evaluate(`__btn('업로드', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => __text().includes('index.html'))`);
  if (!(await evaluate(`__text().includes('index.html')`))) await dump('upload'); assert(await evaluate(`__text().includes('index.html')`), '객체 업로드 후 목록 표시');
  await evaluate(`__go('#/s3/ui-test-bucket/permissions')`);
  await evaluate(`__btn('퍼블릭 읽기 정책 적용').click()`);
  await evaluate(`__wait(() => __text().includes('누구나 읽을 수 있습니다'))`);
  assert(await evaluate(`__text().includes('누구나 읽을 수 있습니다')`), '퍼블릭 읽기 정책 적용 → 퍼블릭 판정');

  console.log('\n[EC2 인스턴스 시작 모달]');
  await evaluate(`__go('#/ec2')`);
  await evaluate(`__btn('인스턴스 시작').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="ImageId"]'))`);
  await evaluate(`__set('name', 'ui-web'); __set('preset', 'Apache 웹 서버 (Amazon Linux)')`);
  assert(await evaluate(`__q('[data-field="UserData"] textarea').value.includes('httpd')`), '사용자 데이터 템플릿 적용');
  await evaluate(`__btn('인스턴스 시작', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => /#\\/ec2\\/instances\\/i-/.test(location.hash))`);
  assert(await evaluate(`/#\\/ec2\\/instances\\/i-/.test(location.hash)`), '인스턴스 시작 후 상세 페이지로 이동');
  await sleep(4500);
  assert(await evaluate(`__text().includes('running')`), '3초 후 running 으로 자동 갱신');
  await evaluate(`__btn('연결 테스트').click()`);
  await evaluate(`__wait(() => __modalText().includes('TCP 80'))`);
  assert(await evaluate(`__modalText().includes('도달')`), '연결 테스트 모달 표시');
  await evaluate(`__q('.modal-foot button').click()`);
  const iid = await evaluate(`location.hash.split('/')[3]`);
  await evaluate(`__go('#/ec2/instances/${iid}/connect')`);
  await evaluate(`const i = __q('.terminal input'); i.value = 'curl http://169.254.169.254/latest/meta-data/instance-id'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await evaluate(`__wait(() => [...__q('.terminal').querySelectorAll('div')].some((d) => d.textContent.trim() === '${iid}'))`);
  assert(await evaluate(`[...__q('.terminal').querySelectorAll('div')].some((d) => d.textContent.trim() === '${iid}')`), '시뮬레이션 셸이 메타데이터 응답');

  console.log('\n[Lambda 생성 + 테스트]');
  await evaluate(`__go('#/lambda')`);
  await evaluate(`__btn('함수 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="FunctionName"]'))`);
  await evaluate(`__set('FunctionName', 'ui-fn')`);
  await evaluate(`__btn('함수 생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('ui-fn'))`);
  assert(await evaluate(`location.hash.includes('#/lambda/functions/ui-fn')`), '함수 생성 후 상세로 이동 (역할 자동 생성 포함)');
  await evaluate(`__wait(() => __btn('Test (호출)'))`);
  await evaluate(`__btn('Test (호출)').click()`);
  await evaluate(`__wait(() => __text().includes('실행 결과'))`);
  assert(await evaluate(`__text().includes('실행 결과: 성공') && __text().includes('Hello, AWS!')`), '테스트 호출 성공 + 응답 표시');

  console.log('\n[IAM 사용자 생성 + 시뮬레이터]');
  await evaluate(`__go('#/iam')`);
  await evaluate(`__btn('사용자 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="UserName"]'))`);
  await evaluate(`__set('UserName', 'ui-user'); [...document.querySelectorAll('[data-field="policies"] input')].find((c) => c.value.endsWith('AmazonS3ReadOnlyAccess')).checked = true`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('ui-user'))`);
  assert(await evaluate(`__text().includes('AmazonS3ReadOnlyAccess')`), '사용자 생성 + 정책 연결 표시');
  await evaluate(`__go('#/iam/simulator/' + encodeURIComponent('arn:aws:iam::123456789012:user/ui-user'))`);
  await evaluate(`__btn('시뮬레이션 실행').click()`);
  await evaluate(`__wait(() => __text().includes('allowed'))`);
  assert(await evaluate(`__text().includes('허용 (allowed)') && __text().includes('암시적 거부')`), '정책 시뮬레이터 결과 표시');

  console.log('\n[DynamoDB / SQS / SNS]');
  await evaluate(`__go('#/dynamodb')`);
  if (!(await evaluate(`!!__btn('테이블 생성')`))) await dump('dynamodb');
  await evaluate(`__btn('테이블 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="TableName"]'))`);
  await evaluate(`__set('TableName', 'UiOrders')`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('UiOrders'))`);
  await sleep(3500);
  await evaluate(`__wait(() => __btn('샘플 데이터'))`);
  await evaluate(`__btn('샘플 데이터').click()`);
  await evaluate(`__wait(() => __btn('넣기'))`);
  await evaluate(`__btn('넣기').click()`);
  await evaluate(`__wait(() => __text().includes('반환 5개'))`);
  assert(await evaluate(`__text().includes('반환 5개')`), '샘플 데이터 5개 삽입 후 Scan 표시');
  await evaluate(`__q('#content select').value = 'query'; __q('#content input[placeholder^="customerId"]').value = 'c1'; __btn('실행').click()`);
  await evaluate(`__wait(() => __text().includes('반환 3개'))`);
  assert(await evaluate(`__text().includes('반환 3개')`), 'Query (customerId=c1) → 3개');
  await evaluate(`__go('#/sqs')`);
  await evaluate(`__btn('대기열 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="QueueName"]'))`);
  await evaluate(`__set('QueueName', 'ui-queue')`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('ui-queue') && __btn('메시지 전송'))`);
  await evaluate(`__btn('메시지 전송').click()`);
  await sleep(800);
  await evaluate(`__wait(() => __btn('메시지 폴링') && __text().includes('관리자 미리보기 · 1개'))`);
  await evaluate(`__btn('메시지 폴링').click()`);
  await evaluate(`__wait(() => __btn('처리 완료'))`);
  assert(await evaluate(`!!__btn('처리 완료')`), 'SQS 전송 → 폴링 → 메시지 수신');
  await evaluate(`__go('#/sns')`);
  await evaluate(`__btn('주제 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="Name"]'))`);
  await evaluate(`__set('Name', 'ui-topic')`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => location.hash.includes('ui-topic') && __btn('구독 생성'))`);
  await evaluate(`__btn('구독 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="Protocol"]'))`);
  await evaluate(`__set('Protocol', 'email'); __set('epText', 'ui@example.com')`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => __text().includes('PendingConfirmation'))`);
  assert(await evaluate(`__text().includes('PendingConfirmation')`), '이메일 구독 → 확인 대기');
  await evaluate(`__go('#/sns/inbox')`);
  await evaluate(`__btn('구독 확인').click()`);
  await evaluate(`__wait(() => !__btn('구독 확인'))`);
  await evaluate(`__go('#/sns/topics/ui-topic')`);
  await evaluate(`__btn('메시지 게시').click()`);
  await evaluate(`__wait(() => __text().includes('DELIVERED'))`);
  assert(await evaluate(`__text().includes('DELIVERED')`), '구독 확인 후 게시 → 이메일 전달');

  console.log('\n[CloudWatch 경보 + 실습]');
  await evaluate(`__go('#/cloudwatch')`);
  await evaluate(`__btn('경보 생성').click()`);
  await evaluate(`__wait(() => __q('.modal [data-field="AlarmName"]'))`);
  await evaluate(`__set('AlarmName', 'ui-alarm'); __set('Threshold', 70)`);
  await evaluate(`__btn('생성', __q('.modal-foot')).click()`);
  await evaluate(`__wait(() => __text().includes('ui-alarm'))`);
  assert(await evaluate(`__text().includes('ui-alarm')`), '경보 생성');
  await evaluate(`__go('#/labs')`);
  assert(await evaluate(`__text().includes('실습 미션') && document.querySelectorAll('.svc-card').length >= 16`), '실습 목록 16개 표시');
  await evaluate(`__go('#/labs/s3-basics')`);
  assert(await evaluate(`__text().includes('✔ 1.')`), '실습 단계 자동 채점 표시');

  const errs = await evaluate(`window.__errs`);
  assert(errs.length === 0, 'JS 런타임 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
}
main().catch((e) => bad('예외: ' + e.message)).finally(() => { try { ws && ws.close(); } catch (e) { /* */ } chrome.kill(); console.log(`\n통과 ${pass}, 실패 ${fail}`); process.exit(fail ? 1 : 0); });
