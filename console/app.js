/* AWS 시뮬레이터 콘솔 — 공통 프레임워크 + 홈/실습/요금/기록 페이지 */
(function () {
  'use strict';
  const App = (window.App = { routes: {}, region: localStorage.getItem('awsim.region') || 'ap-northeast-2', meta: null, pollers: [] });

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }
  App.h = h;
  const $ = (sel, root = document) => root.querySelector(sel);
  App.$ = $;

  // ---------- API ----------
  App.api = async function (svc, action, params = {}, opts = {}) {
    const res = await fetch(`/api/${svc}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-region': App.region }, body: JSON.stringify(params) });
    let body = {};
    try { body = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) {
      const err = new Error(body.message || res.statusText);
      err.code = body.__type || 'Error';
      if (!opts.silent) App.toast(err.message, 'error', `${err.code} (${action})`);
      throw err;
    }
    return body;
  };
  App.get = async (path) => (await fetch(path + (path.includes('?') ? '&' : '?') + 'region=' + App.region)).json();

  // ---------- toasts ----------
  App.toast = function (msg, type = 'info', title) {
    const t = h('div', { class: 'toast ' + type }, title ? h('b', null, title) : null, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 9000 : 4500);
    t.addEventListener('click', () => t.remove());
  };

  // ---------- modal / forms ----------
  function buildField(f, values) {
    const id = 'f-' + f.name;
    let input;
    const val = f.value !== undefined ? f.value : '';
    if (f.type === 'select') {
      input = h('select', { id, name: f.name }, (f.options || []).map((o) => { const [v, label] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(val) }, label); }));
      if (f.onChange) input.addEventListener('change', (e) => f.onChange(e.target.value, values));
    } else if (f.type === 'textarea' || f.type === 'json' || f.type === 'code') {
      input = h('textarea', { id, name: f.name, class: f.type !== 'textarea' ? 'code' : '', placeholder: f.placeholder || '', rows: f.rows || (f.type === 'code' ? 14 : 4), spellcheck: false }, typeof val === 'object' ? JSON.stringify(val, null, 2) : val);
      input.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = input.selectionStart; input.value = input.value.slice(0, s) + '  ' + input.value.slice(input.selectionEnd); input.selectionStart = input.selectionEnd = s + 2; } });
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: !!val });
    } else if (f.type === 'multiselect') {
      input = h('div', { class: 'chips', id }, (f.options || []).map((o) => { const [v, label] = Array.isArray(o) ? o : [o, o]; return h('label', { style: { display: 'block', fontWeight: 400 } }, h('input', { type: 'checkbox', value: v, checked: (val || []).includes(v) }), ' ', label); }));
    } else {
      input = h('input', { id, name: f.name, type: f.type || 'text', value: val, placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, list: f.datalist ? id + '-list' : undefined, autocomplete: 'off' });
    }
    if (f.onInput) input.addEventListener('input', (e) => f.onInput(e.target.value, values));
    const wrap = h('div', { class: 'field' + (f.type === 'checkbox' ? ' inline' : ''), 'data-field': f.name },
      f.type === 'checkbox' ? [input, h('label', { for: id }, f.label)] : [h('label', { for: id }, f.label, f.required ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ' (필수)') : null), input],
      f.datalist ? h('datalist', { id: id + '-list' }, f.datalist.map((d) => h('option', { value: d }))) : null,
      f.hint ? h('div', { class: 'hint', html: f.hint }) : null,
      h('div', { class: 'err hidden' }));
    wrap._get = () => {
      if (f.type === 'checkbox') return input.checked;
      if (f.type === 'number') return input.value === '' ? undefined : Number(input.value);
      if (f.type === 'json') { if (!input.value.trim()) return undefined; try { return JSON.parse(input.value); } catch (e) { throw new Error(`${f.label}: JSON 구문 오류 — ${e.message}`); } }
      if (f.type === 'multiselect') return [...input.querySelectorAll('input:checked')].map((c) => c.value);
      return input.value;
    };
    wrap._input = input;
    return wrap;
  }
  App.modal = function ({ title, fields = [], body, submitLabel = '생성', cancelLabel = '취소', wide = false, onSubmit, danger = false }) {
    return new Promise((resolve) => {
      const values = {};
      const fieldEls = fields.map((f) => buildField(f, values));
      const errBox = h('div', { class: 'alert error hidden' });
      const close = (v) => { root.innerHTML = ''; resolve(v); };
      const submit = async () => {
        errBox.classList.add('hidden');
        const out = {};
        try {
          for (let i = 0; i < fields.length; i++) { out[fields[i].name] = fieldEls[i]._get(); if (fields[i].required && (out[fields[i].name] === '' || out[fields[i].name] === undefined)) throw new Error(`${fields[i].label} 값을 입력하세요.`); }
          btn.disabled = true;
          const r = onSubmit ? await onSubmit(out, { close, setError }) : out;
          if (r !== false) close(r === undefined ? out : r);
        } catch (e) { setError(e.message); } finally { btn.disabled = false; }
      };
      const setError = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); };
      const btn = h('button', { class: danger ? 'danger' : 'primary', onclick: submit }, submitLabel);
      const root = $('#modal-root');
      const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
        h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'link', onclick: () => close(null) }, '✕')),
        h('div', { class: 'modal-body' }, errBox, body || null, fieldEls.length ? h('div', { class: 'form' }, fieldEls) : null),
        h('div', { class: 'modal-foot' }, onSubmit || fields.length ? h('button', { onclick: () => close(null) }, cancelLabel) : null, onSubmit || fields.length ? btn : h('button', { class: 'primary', onclick: () => close(null) }, '닫기')));
      root.innerHTML = '';
      root.appendChild(h('div', { class: 'backdrop', onclick: (e) => { if (e.target.classList.contains('backdrop')) close(null); } }, box));
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit(); if (e.key === 'Escape') close(null); });
      const first = box.querySelector('input,select,textarea'); if (first) first.focus();
    });
  };
  App.confirm = (msg, label = '삭제') => App.modal({ title: '확인', body: h('p', null, msg), submitLabel: label, danger: true, onSubmit: () => true });
  App.showJson = (title, obj) => App.modal({ title, wide: true, body: h('pre', null, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) });

  // ---------- table ----------
  App.table = function ({ columns, rows, onRow, empty = '리소스가 없습니다.', rowClass }) {
    const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { style: c.width ? { width: c.width } : null }, c.label))));
    const tbody = h('tbody', null, rows.length ? rows.map((r, i) => h('tr', { class: (onRow ? 'clickable ' : '') + (rowClass ? rowClass(r) : ''), onclick: onRow ? (e) => { if (e.target.closest('button,a,input,select')) return; onRow(r, i); } : null },
      columns.map((c) => { let v = c.render ? c.render(r, i) : r[c.key]; if (v === undefined || v === null) v = '-'; if (typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v)) v = JSON.stringify(v); return h('td', null, v); }))) : h('tr', null, h('td', { class: 'empty', colspan: columns.length }, empty)));
    return h('table', { class: 'grid' }, thead, tbody);
  };
  App.badge = (text, color = '') => h('span', { class: 'badge ' + color }, text);
  App.stateBadge = function (state) {
    const s = (state && state.Name) || state || '';
    const color = { running: 'green', available: 'green', Active: 'green', ACTIVE: 'green', active: 'green', OK: 'green', Enabled: 'green', Confirmed: 'green', attached: 'green', 'in-use': 'green', pending: 'yellow', CREATING: 'yellow', stopping: 'yellow', 'shutting-down': 'yellow', INSUFFICIENT_DATA: 'grey', PendingConfirmation: 'yellow', stopped: 'red', terminated: 'grey', ALARM: 'red', Disabled: 'grey', Suspended: 'yellow' }[s] || 'grey';
    return h('span', null, h('span', { class: 'dot ' + color }), s);
  };
  App.tabs = (items, active, base) => h('div', { class: 'tabs' }, items.map((t) => h('a', { href: `${base}/${t.id}`, class: t.id === active ? 'active' : '' }, t.label)));
  App.card = (title, body, head = []) => h('div', { class: 'card' }, title !== null ? h('div', { class: 'card-head' }, typeof title === 'string' ? h('h2', null, title) : title, head) : null, h('div', { class: 'card-body' }, body));
  App.kv = (pairs) => h('div', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v === undefined || v === null || v === '' ? '-' : v))));
  App.breadcrumb = (...items) => h('div', { class: 'breadcrumb' }, items.map((it, i) => [i ? ' › ' : null, Array.isArray(it) ? h('a', { href: it[1] }, it[0]) : it]));
  App.fmtDate = (d) => (d ? new Date(d).toLocaleString('ko-KR', { hour12: false }) : '-');
  App.fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
  App.nameTag = (r) => { const t = (r.Tags || []).find((x) => x.Key === 'Name'); return t ? t.Value : ''; };
  App.copy = (text) => { navigator.clipboard && navigator.clipboard.writeText(text); App.toast('복사했습니다: ' + text, 'success'); };
  App.copyBtn = (text) => h('button', { class: 'link small', onclick: () => App.copy(text), title: '복사' }, '📋');
  App.cli = (cmd) => h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'CLI: ', h('code', null, cmd), ' ', App.copyBtn(cmd));

  // ---------- chart ----------
  App.chart = function (series, { height = 200, unit = '' } = {}) {
    const canvas = h('canvas', { class: 'chart' });
    canvas.style.height = height + 'px';
    const draw = () => {
      const w = (canvas.width = canvas.clientWidth * devicePixelRatio || 600), hh = (canvas.height = height * devicePixelRatio);
      const ctx = canvas.getContext('2d');
      ctx.scale(devicePixelRatio, devicePixelRatio);
      const W = w / devicePixelRatio, H = height;
      ctx.clearRect(0, 0, W, H);
      const pad = { l: 44, r: 10, t: 10, b: 24 };
      const all = series.flatMap((s) => s.points);
      if (!all.length) { ctx.fillStyle = '#879596'; ctx.font = '13px sans-serif'; ctx.fillText('데이터 없음 (지표는 10초마다 수집됩니다)', pad.l, H / 2); return; }
      const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1, y0 = 0, y1 = Math.max(1, ...ys) * 1.1;
      const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r), Y = (y) => H - pad.b - ((y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
      ctx.strokeStyle = '#eaeded'; ctx.fillStyle = '#545b64'; ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) { const y = y0 + ((y1 - y0) * i) / 4; ctx.beginPath(); ctx.moveTo(pad.l, Y(y)); ctx.lineTo(W - pad.r, Y(y)); ctx.stroke(); ctx.fillText(y.toFixed(y1 > 10 ? 0 : 1) + unit, 2, Y(y) + 4); }
      for (let i = 0; i <= 4; i++) { const x = x0 + ((x1 - x0) * i) / 4; ctx.fillText(new Date(x).toLocaleTimeString('ko-KR', { hour12: false }), X(x) - 20, H - 6); }
      const colors = ['#0972d3', '#ec7211', '#1d8102', '#d13212', '#8c4fff'];
      series.forEach((s, i) => { ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 2; ctx.beginPath(); s.points.forEach((p, j) => (j ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)))); ctx.stroke(); ctx.fillStyle = colors[i % colors.length]; ctx.fillText(s.label, pad.l + 8 + i * 140, pad.t + 10); });
    };
    setTimeout(draw, 0);
    canvas._draw = draw;
    return canvas;
  };

  // ---------- routing ----------
  App.register = (prefix, fn) => (App.routes[prefix] = fn);
  App.navigate = (hash) => { location.hash = hash; };
  App.refresh = () => render();
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    for (const p of App.pollers) clearInterval(p); App.pollers = [];
    const segs = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const svc = segs[0] || 'home';
    document.querySelectorAll('#sidenav a').forEach((a) => a.classList.toggle('active', a.dataset.svc === svc));
    const fn = App.routes[svc] || App.routes.home;
    const content = $('#content');
    content.innerHTML = '<div class="muted">불러오는 중…</div>';
    try {
      const node = await fn(segs.slice(1), segs);
      if (seq !== renderSeq) return;
      content.innerHTML = '';
      append(content, [node]);
      content.dataset.route = location.hash;
    } catch (e) {
      if (seq !== renderSeq) return;
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'alert error' }, h('b', null, '페이지를 불러오지 못했습니다: '), e.message));
      content.dataset.route = location.hash;
      console.error(e);
    }
  }
  App.poll = (fn, ms) => App.pollers.push(setInterval(fn, ms));

  // ---------- start ----------
  App.start = async function () {
    App.meta = await (await fetch('/api/meta')).json();
    $('#account-id').textContent = App.meta.AccountId;
    const sel = $('#region-select');
    for (const r of App.meta.Regions) sel.appendChild(h('option', { value: r.id, selected: r.id === App.region }, `${r.name} ${r.id}`));
    sel.addEventListener('change', () => { App.region = sel.value; localStorage.setItem('awsim.region', App.region); render(); });
    $('#btn-reset').addEventListener('click', async () => {
      if (await App.confirm('모든 리전의 모든 리소스와 실습 진행 상황이 삭제됩니다. 계속할까요?', '초기화')) { await fetch('/api/reset', { method: 'POST' }); App.toast('초기화되었습니다.', 'success'); render(); }
    });
    const search = $('#svc-search'), results = $('#svc-search-results');
    const SERVICES = [['IAM', '#/iam', '사용자, 그룹, 역할, 정책'], ['VPC', '#/vpc', '가상 네트워크, 서브넷, 라우팅'], ['EC2', '#/ec2', '가상 서버, 보안 그룹, EBS'], ['S3', '#/s3', '객체 스토리지, 정적 웹 사이트'], ['Lambda', '#/lambda', '서버리스 함수'], ['DynamoDB', '#/dynamodb', 'NoSQL 데이터베이스'], ['SQS', '#/sqs', '메시지 대기열'], ['SNS', '#/sns', '알림/푸시 주제'], ['CloudWatch', '#/cloudwatch', '지표, 경보, 로그'], ['실습 미션', '#/labs', '단계별 연습 과제'], ['요금', '#/billing', '비용 추정']];
    search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); results.innerHTML = ''; if (!q) return results.classList.add('hidden'); const m = SERVICES.filter((s) => s[0].toLowerCase().includes(q) || s[2].includes(q)); m.forEach((s) => results.appendChild(h('a', { href: s[1], onclick: () => { results.classList.add('hidden'); search.value = ''; } }, h('b', null, s[0]), ' ', h('span', { class: 'muted small' }, s[2])))); results.classList.toggle('hidden', !m.length); });
    search.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 200));
    window.addEventListener('hashchange', render);
    render();
  };

  // ========== 홈 ==========
  App.register('home', async () => {
    const ov = await App.get('/api/overview');
    const c = ov.Counts;
    const cards = [
      ['IAM', '#/iam', `${c.iamUsers} 사용자 · ${c.iamRoles} 역할`, c.iamUsers], ['VPC', '#/vpc', 'VPC', c.vpcs], ['EC2', '#/ec2', `실행 중 ${c.ec2Running} / 전체 ${c.ec2Total}`, c.ec2Running], ['S3', '#/s3', '버킷 (글로벌)', c.s3Buckets], ['Lambda', '#/lambda', '함수', c.lambda], ['DynamoDB', '#/dynamodb', '테이블', c.dynamodb], ['SQS', '#/sqs', '대기열', c.sqs], ['SNS', '#/sns', '주제', c.sns], ['CloudWatch', '#/cloudwatch', `경보 ${c.alarms} (ALARM ${c.alarmsInAlarm})`, c.alarms],
    ];
    const labs = ov.Labs;
    return h('div', null,
      h('h1', null, '콘솔 홈 ', h('span', { class: 'muted', style: { fontSize: '14px' } }, App.region)),
      h('div', { class: 'alert info' }, h('b', null, '이 콘솔은 AWS 를 흉내 낸 로컬 시뮬레이터입니다. '), '실제 요금이 발생하지 않으니 마음껏 만들고 지우며 연습하세요. 오른쪽 위 리전을 바꾸면 리전별 리소스(EC2, VPC, Lambda …)가 분리됩니다. S3 와 IAM 은 글로벌입니다.'),
      h('div', { class: 'two-col' },
        h('div', null,
          h('h3', null, '서비스'),
          h('div', { class: 'cards-grid' }, cards.map((cd) => h('a', { class: 'svc-card', href: cd[1] }, h('div', { class: 'name' }, cd[0]), h('div', { class: 'big' }, cd[3]), h('div', { class: 'muted small' }, cd[2]))))),
        h('div', null,
          h('h3', null, '실습 미션 진행'),
          App.card(null, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('div', { class: 'stat' }, `${labs.completed}/${labs.total}`), h('div', { style: { flex: 1 } }, h('div', { class: 'progress' }, h('div', { style: { width: (100 * labs.completed) / labs.total + '%' } })))),
            h('div', { style: { marginTop: '10px' } }, labs.labs.filter((l) => !l.done).slice(0, 4).map((l) => h('div', { style: { padding: '4px 0' } }, h('a', { href: '#/labs/' + l.id }, `Lv${l.level} · ${l.title}`), ' ', h('span', { class: 'muted small' }, `${Math.round(l.progress * 100)}%`)))),
            h('a', { href: '#/labs' }, '모든 실습 보기 →'),
          ]),
          h('h3', null, '예상 월 요금'),
          App.card(null, [h('div', { class: 'stat' }, `$${ov.Cost.EstimatedMonthlyUsd.toFixed(2)}`), h('div', { class: 'muted small' }, `프리 티어 제외 시 $${ov.Cost.EstimatedMonthlyUsdBeyondFreeTier.toFixed(2)} · `, h('a', { href: '#/billing' }, '자세히'))]),
          h('h3', null, '최근 활동'),
          App.card(null, ov.Recent.length ? ov.Recent.map((e) => h('div', { class: 'small', style: { padding: '3px 0', borderBottom: '1px solid #eaeded' } }, h('span', { class: 'muted' }, new Date(e.time).toLocaleTimeString('ko-KR', { hour12: false })), ' ', h('b', null, e.service), ' ', e.action, ' ', h('span', { class: 'muted' }, e.detail || ''))) : h('span', { class: 'muted' }, '아직 활동이 없습니다.')))));
  });

  // ========== 실습 ==========
  App.register('labs', async ([id]) => {
    const data = await App.get('/api/labs');
    if (id) {
      const lab = data.labs.find((l) => l.id === id);
      if (!lab) return h('div', null, '실습을 찾을 수 없습니다.');
      const box = h('div');
      const draw = (lab) => {
        box.innerHTML = '';
        append(box, [
          App.breadcrumb(['실습 미션', '#/labs'], lab.title),
          h('h1', null, h('span', { class: 'level' }, 'Lv' + lab.level), ' ', lab.title, ' ', lab.done ? App.badge('완료 ✔', 'green') : App.badge(`${Math.round(lab.progress * 100)}%`, 'blue')),
          h('div', { class: 'two-col' },
            h('div', null,
              App.card('목표', h('p', null, lab.description)),
              App.card('단계 (자동 채점 · 5초마다 갱신)', h('ul', { class: 'steps' }, lab.steps.map((s, i) => h('li', { class: s.ok ? 'ok' : 'todo' }, s.ok ? '✔ ' : '○ ', `${i + 1}. ${s.label}`)))),
              lab.done ? h('div', { class: 'alert success' }, `🎉 실습을 완료했습니다! (${App.fmtDate(lab.completedAt)})`) : null),
            h('div', null,
              App.card('콘솔에서 하기', h('p', null, `왼쪽 메뉴에서 `, h('a', { href: '#/' + lab.service.toLowerCase().replace('billing', 'billing') }, lab.service), ' 서비스로 이동해 단계대로 진행하세요. 이 페이지는 열어 둔 채로 다른 탭에서 작업하면 진행 상황이 자동으로 갱신됩니다.')),
              App.card('CLI 로 하기', [h('p', { class: 'small muted' }, '프로젝트 폴더에서 node cli/awsim.js … 로 실행하거나, npm link 후 awsim 명령으로 실행합니다. <id> 부분은 실제 리소스 ID 로 바꾸세요.'), h('pre', null, lab.cli.join('\n\n'))])))]);
      };
      draw(lab);
      App.poll(async () => { const d = await App.get('/api/labs'); const l = d.labs.find((x) => x.id === id); if (l && JSON.stringify(l.steps) !== JSON.stringify(lab.steps) || (l && l.done !== lab.done)) { Object.assign(lab, l); draw(lab); if (l.done) App.toast('실습 완료! 🎉', 'success', lab.title); } }, 5000);
      return box;
    }
    const resetBtn = h('button', { class: 'link danger small', onclick: async () => { if (await App.confirm('실습 진행 기록(완료 표시/카운터)을 초기화합니다. 리소스는 유지됩니다.', '초기화')) { await fetch('/api/labs/reset', { method: 'POST' }); App.refresh(); } } }, '진행 기록 초기화');
    return h('div', null,
      h('h1', null, '실습 미션 ', h('span', { class: 'muted', style: { fontSize: '14px' } }, `${data.completed}/${data.total} 완료`), ' ', resetBtn),
      h('div', { class: 'progress', style: { marginBottom: '16px' } }, h('div', { style: { width: (100 * data.completed) / data.total + '%' } })),
      h('p', { class: 'muted' }, '각 미션은 실제 리소스 상태를 보고 자동으로 채점됩니다. 콘솔 또는 CLI 어느 쪽으로 해도 됩니다. 레벨 1부터 차례로 진행하는 것을 권장합니다.'),
      h('div', { class: 'cards-grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' } }, data.labs.map((l) => h('a', { class: 'svc-card', href: '#/labs/' + l.id },
        h('div', { class: 'name' }, h('span', { class: 'level' }, 'Lv' + l.level), ' ', App.badge(l.service, 'blue'), ' ', l.done ? '✔ ' : '', l.title),
        h('div', { class: 'muted small', style: { margin: '6px 0', minHeight: '36px' } }, l.description.slice(0, 90) + (l.description.length > 90 ? '…' : '')),
        h('div', { class: 'progress' }, h('div', { style: { width: l.progress * 100 + '%' } })),
        h('div', { class: 'small muted', style: { marginTop: '4px' } }, `${l.steps.filter((s) => s.ok).length}/${l.steps.length} 단계 · 약 ${l.minutes}분`)))));
  });

  // ========== 요금 ==========
  App.register('billing', async () => {
    const est = await App.api('billing', 'GetCostEstimate');
    const bySvc = {};
    for (const l of est.Lines) bySvc[l.Service] = (bySvc[l.Service] || 0) + l.MonthlyUsd;
    return h('div', null,
      h('h1', null, '요금 추정 (Billing)'),
      h('div', { class: 'alert warn' }, '시뮬레이터의 근사치입니다. 실제 AWS 요금은 리전/사용량/프리 티어 조건에 따라 다릅니다. 이 페이지의 핵심은 "무엇이 과금되는지" 감을 잡는 것입니다.'),
      h('div', { class: 'cards-grid' },
        h('div', { class: 'svc-card' }, h('div', { class: 'name' }, '예상 월 요금'), h('div', { class: 'big' }, `$${est.EstimatedMonthlyUsd.toFixed(2)}`)),
        h('div', { class: 'svc-card' }, h('div', { class: 'name' }, '프리 티어 제외 시'), h('div', { class: 'big' }, `$${est.EstimatedMonthlyUsdBeyondFreeTier.toFixed(2)}`)),
        Object.entries(bySvc).map(([k, v]) => h('div', { class: 'svc-card' }, h('div', { class: 'name' }, k), h('div', { class: 'big' }, `$${v.toFixed(2)}`)))),
      h('h3', null, '리소스별 상세'),
      App.card(null, App.table({ columns: [{ key: 'Service', label: '서비스' }, { key: 'Resource', label: '리소스' }, { key: 'Detail', label: '내용', render: (r) => h('span', null, r.Detail, r.Warning ? [' ', App.badge('⚠ 숨은 과금', 'red')] : null, r.FreeTier ? [' ', App.badge('프리 티어', 'green')] : null) }, { label: '시간당', render: (r) => `$${r.HourlyUsd.toFixed(4)}` }, { label: '월(730h)', render: (r) => `$${r.MonthlyUsd.toFixed(2)}` }], rows: est.Lines, empty: '과금 대상 리소스가 없습니다.' })),
      App.cli('awsim billing get-cost-estimate'));
  });

  // ========== 기록 ==========
  App.register('history', async () => {
    const d = await App.get('/api/history?limit=200');
    return h('div', null, h('h1', null, '이벤트 기록 (CloudTrail 흉내)'), App.card(null, App.table({ columns: [{ label: '시간', render: (r) => App.fmtDate(r.time) }, { key: 'service', label: '서비스' }, { key: 'action', label: '작업' }, { key: 'detail', label: '내용' }, { key: 'caller', label: '호출자' }], rows: d.Events, empty: '기록이 없습니다.' })));
  });

  // ========== API 도움말 ==========
  App.register('api', async () => {
    const m = App.meta;
    const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    return h('div', null, h('h1', null, 'API / CLI 도움말'),
      App.card('HTTP API', [h('p', null, '모든 작업은 ', h('code', null, 'POST /api/<service>/<Action>'), ' 에 JSON 본문으로 호출합니다. 리전은 ', h('code', null, 'x-region'), ' 헤더 또는 ', h('code', null, 'Region'), ' 필드로 지정합니다.'),
        h('pre', null, `curl -X POST http://localhost:${m.Port}/api/s3/CreateBucket -H "Content-Type: application/json" -H "x-region: ${App.region}" -d '{"Bucket":"my-bucket"}'`)]),
      App.card('CLI (AWS CLI 문법 호환)', [h('pre', null, `node cli/awsim.js ec2 describe-instances --output table\nnode cli/awsim.js s3 mb s3://my-bucket\nnode cli/awsim.js lambda invoke --function-name hello --payload '{"name":"AWS"}' out.json\nnode cli/awsim.js labs            # 실습 진행 상황\n\n# 전역 명령으로 쓰려면 (프로젝트 폴더에서):  npm link   →  awsim ec2 describe-instances`)]),
      App.card('Lambda 안에서 다른 서비스 호출', [h('pre', null, `// Node.js: 전역 AWS 객체 (aws-sdk v2 스타일)\nconst s3 = new AWS.S3();\nawait s3.putObject({ Bucket: 'b', Key: 'k', Body: 'hi' }).promise();\nconst ddb = new AWS.DynamoDB.DocumentClient();\nawait ddb.put({ TableName: 'Orders', Item: { customerId: 'c1', orderId: 'o9' } }).promise();\n\n# Python: boto3 shim\nimport boto3\nboto3.client('sqs').send_message(QueueUrl='…', MessageBody='hi')\nboto3.resource('dynamodb').Table('Orders').put_item(Item={'customerId': 'c1', 'orderId': 'o9'})`)]),
      Object.entries(m.Services).map(([svc, acts]) => App.card(`${svc} (${acts.length} 작업)`, h('div', { class: 'chips' }, acts.map((a) => h('span', { title: 'awsim ' + svc + ' ' + kebab(a) }, kebab(a)))))));
  });
})();
