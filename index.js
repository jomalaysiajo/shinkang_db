// 신강인테크 DB — JavaScript

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const GAS_URL = 'https://script.google.com/macros/s/AKfycby6NWoZ1tLoaitWYbEzgJw-Q87PVMQNiomAy5rLDUuNgKsH8aaDZ0t8YCPUzhxPhb02Qw/exec';
const LS_KEY  = 'sgintech_db_key';

let API_KEY = '';
let CACHE   = {}; // 설정 캐시

// ── 성능 최적화: debounce + 행 데이터 캐시 ───────────────────
// debounce: 연속 입력 시 마지막 호출만 실행
function debounce(fn, delay = 80) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
// 행별 계산 결과 캐시 (idx → {fcost, fdisc, kwcost, kwdisc, final, dfinal})
const _rowCache = {};

// ═══════════════════════════════════════════════════════
// PAGINATION ENGINE
// ═══════════════════════════════════════════════════════
const PAGE_SIZE = 50; // 페이지당 행 수

/** rows 배열을 page·size로 슬라이스하여 메타 포함 반환 */
function paginateRows(rows, page, size = PAGE_SIZE) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p     = Math.max(1, Math.min(page, pages));
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, total };
}

/**
 * 페이지 바 HTML 생성
 * @param {number} total  전체 행 수
 * @param {number} page   현재 페이지 (1-based)
 * @param {number} pages  전체 페이지 수
 * @param {number} size   페이지 크기
 * @param {string} gotoFn 페이지 변경 시 호출할 전역 함수명 (숫자 1개 인자)
 */
function renderPageBar(total, page, pages, size, gotoFn) {
  if (pages <= 1) {
    return `<div style="padding:8px 14px;font-size:11px;color:var(--text3)">총 ${total}건</div>`;
  }
  const from = (page - 1) * size + 1;
  const to   = Math.min(page * size, total);
  const btn  = (p, label, disabled) =>
    `<button class="btn btn-secondary btn-sm" style="min-width:28px;padding:2px 6px"
      onclick="${gotoFn}(${p})" ${disabled ? 'disabled' : ''}>${label}</button>`;

  let numBtns = '';
  const start = Math.max(1, page - 2);
  const end   = Math.min(pages, page + 2);
  for (let i = start; i <= end; i++) {
    numBtns += `<button class="btn ${i === page ? 'btn-primary' : 'btn-secondary'} btn-sm"
      style="min-width:28px;padding:2px 6px" onclick="${gotoFn}(${i})">${i}</button>`;
  }

  return `
  <div style="display:flex;align-items:center;justify-content:space-between;
              padding:8px 14px;font-size:11px;color:var(--text3);border-top:1px solid var(--border)">
    <span>${from}–${to} / 전체 ${total}건</span>
    <div style="display:flex;gap:3px;align-items:center">
      ${btn(1, '«', page === 1)}
      ${btn(page - 1, '‹', page === 1)}
      ${numBtns}
      ${btn(page + 1, '›', page === pages)}
      ${btn(pages, '»', page === pages)}
    </div>
  </div>`;
}

// 테이블별 페이지 상태
let _partsPage = 1;   let _partsDisplayRows = [];
let _equipPage = 1;   let _equipDisplayRows = [];
let _quotPage  = 1;   let _quotAllRows      = [];
let _purchPage = 1;   let _purchAllRows     = [];
let _salesPage = 1;   let _salesAllRows     = [];

// ═══════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════
// ── API 응답 검증 헬퍼 ─────────────────────────────────────
function validateApiResponse(data, context) {
  if (typeof data !== 'object' || data === null)
    throw new Error(`[${context}] 잘못된 응답 형식 (객체 아님)`);
  if (!Object.prototype.hasOwnProperty.call(data, 'ok'))
    throw new Error(`[${context}] ok 필드 없음`);
  return data;
}

async function api(body) {
  body.apiKey = API_KEY;
  let res;
  try {
    res = await fetch(GAS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify(body),
    });
  } catch(networkErr) {
    throw new Error('네트워크 오류: ' + networkErr.message);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  let data;
  try {
    data = await res.json();
  } catch(parseErr) {
    throw new Error('응답 파싱 오류: JSON 형식이 아닙니다');
  }

  validateApiResponse(data, body.action || '?');

  if (!data.ok && data.error === 'UNAUTHORIZED') {
    showToast('인증 오류: 비밀번호를 확인하세요', 'error');
    doLogout();
    throw new Error('UNAUTHORIZED');
  }
  return data;
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
// ── 서버 비밀번호 검증 공통 함수 ──────────────────────────────
async function verifyWithServer(pw) {
  let res;
  try {
    res = await fetch(GAS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action: 'verify', apiKey: pw }),
    });
  } catch(networkErr) {
    throw Object.assign(new Error('NETWORK'), { detail: networkErr.message });
  }
  if (!res.ok) throw Object.assign(new Error('HTTP'), { detail: `${res.status} ${res.statusText}` });

  let data;
  try { data = await res.json(); }
  catch(e) { throw Object.assign(new Error('PARSE'), { detail: 'JSON 파싱 실패' }); }

  // 응답 구조 검증: 반드시 { ok: boolean } 형태여야 함
  if (typeof data !== 'object' || data === null || typeof data.ok !== 'boolean')
    throw Object.assign(new Error('INVALID'), { detail: '응답에 ok 필드 없음: ' + JSON.stringify(data).slice(0,80) });

  return data.ok;  // true = 인증 성공
}

async function doLogin() {
  const pw    = document.getElementById('login-pw').value.trim();
  const errEl = document.getElementById('login-error');
  const btn   = document.querySelector('.login-btn');
  if (!pw) { errEl.textContent = '비밀번호를 입력하세요'; return; }
  if (pw.length < 4) { errEl.textContent = '비밀번호는 4자 이상이어야 합니다'; return; }

  btn.textContent = '확인 중...'; btn.disabled = true;
  errEl.textContent = '';
  document.getElementById('login-pw').classList.remove('error');

  try {
    const ok = await verifyWithServer(pw);
    if (ok) {
      API_KEY = pw;
      localStorage.setItem(LS_KEY, pw);
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app').classList.add('visible');
      loadCache();
      navigate('dashboard');
    } else {
      errEl.textContent = '비밀번호가 올바르지 않습니다';
      document.getElementById('login-pw').classList.add('error');
    }
  } catch(e) {
    const msgMap = {
      NETWORK: '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.',
      HTTP:    `서버 오류 (${e.detail}). 잠시 후 다시 시도해 주세요.`,
      PARSE:   '서버 응답을 읽지 못했습니다. 관리자에게 문의하세요.',
      INVALID: '예상치 못한 응답 형식입니다. 관리자에게 문의하세요.',
    };
    errEl.textContent = msgMap[e.message] || '알 수 없는 오류가 발생했습니다.';
  } finally {
    btn.textContent = '접속'; btn.disabled = false;
  }
}

function doLogout() {
  localStorage.removeItem(LS_KEY);
  API_KEY = ''; CACHE = {};
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-pw').value = '';
  document.getElementById('login-error').textContent = '';
}

// 저장된 키로 자동 로그인 시도
async function tryAutoLogin() {
  const saved = localStorage.getItem(LS_KEY);
  if (!saved) return;
  try {
    const ok = await verifyWithServer(saved);
    if (ok) {
      API_KEY = saved;
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app').classList.add('visible');
      loadCache();
      navigate('dashboard');
    } else {
      localStorage.removeItem(LS_KEY); // 저장된 키가 유효하지 않으면 제거
    }
  } catch(e) {} // 네트워크 오류 시 조용히 무시 (수동 로그인 대기)
}

// ═══════════════════════════════════════════════════════
// CACHE — fetchCache(keys?) 단일 함수로 통합
// ═══════════════════════════════════════════════════════

// 캐시 키별 API 요청 정의
const CACHE_DEFS = {
  staff:     { req: () => api({ action:'getSettings', sheet:'Settings_Staff'     }), filter: r => r['사용여부']==='Y' },
  vendor:    { req: () => api({ action:'getSettings', sheet:'Settings_Vendor'    }), filter: r => r['사용여부']==='Y' },
  project:   { req: () => api({ action:'getSettings', sheet:'Settings_Project'   }), filter: r => r['상태']!=='완료'  },
  currency:  { req: () => api({ action:'getSettings', sheet:'Settings_Currency'  }), filter: r => r['사용여부']==='Y' },
  unit:      { req: () => api({ action:'getSettings', sheet:'Settings_Unit'      }), filter: r => r['사용여부']==='Y' },
  category:  { req: () => api({ action:'getSettings', sheet:'Settings_Category'  }), filter: r => r['사용여부']==='Y' },
  division:  { req: () => api({ action:'getSettings', sheet:'Settings_Division'  }), filter: r => r['사용여부']==='Y' },
  parts:     { req: () => api({ action:'getParts'     }), filter: r => r['사용여부']==='Y' },
  equipment: { req: () => api({ action:'getEquipment' }), filter: r => r['사용여부']==='Y' },
};

// keys 생략 시 전체 로드, 배열 전달 시 해당 키만 갱신
async function fetchCache(keys) {
  const targets = keys
    ? (Array.isArray(keys) ? keys : [keys])
    : Object.keys(CACHE_DEFS);

  try {
    const results = await Promise.all(
      targets.map(k => CACHE_DEFS[k]?.req())
    );
    targets.forEach((k, i) => {
      const def = CACHE_DEFS[k];
      if (!def || !results[i]) return;
      CACHE[k] = (results[i].rows || []).filter(def.filter);
    });
    if (!keys || keys.includes('division')) updateTypeDatelist();
  } catch(e) {
    console.warn('[fetchCache] 일부 캐시 로드 실패:', e.message);
    showToast('설정 데이터 로드 실패 — ' + e.message, 'error');
  }
}

// 하위 호환 래퍼
const loadCache    = ()     => fetchCache(null);
const refreshCache = (type) => fetchCache(type ? [type] : null);

// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════
const PAGE_META = {
  'dashboard':         { title: '대시보드',      sub: '전체 현황 요약' },
  'settings-staff':    { title: '직원 관리',      sub: '설정' },
  'settings-vendor':   { title: '공급사/거래처 관리', sub: '설정' },
  'settings-project':  { title: '프로젝트 관리',  sub: '설정' },
  'settings-currency': { title: '통화 관리',      sub: '설정' },
  'settings-unit':     { title: '단위 관리',      sub: '설정' },
  'settings-category': { title: '카테고리 관리',  sub: '설정' },
  'settings-division': { title: '구분 관리',      sub: '설정' },
  'settings-codes':    { title: '코드 관리',       sub: '설정 — 통화 / 단위 / 카테고리 / 구분' },
  'master-parts':      { title: 'Parts',          sub: 'Master DB' },
  'master-equipment':  { title: 'Equipment',      sub: 'Master DB' },
  'reg-quotation':     { title: '견적 등록',      sub: '등록' },
  'reg-purchase':      { title: '구매 등록',      sub: '등록' },
  'reg-sales':         { title: '판매 등록',      sub: '등록' },
  'list-quotation':    { title: '견적 목록',      sub: '리스트' },
  'list-purchase':     { title: '구매 목록',      sub: '리스트' },
  'list-sales':        { title: '판매 목록',      sub: '리스트' },
};

function navigate(page) {
  // 사이드바 활성화
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.nav-item');
  items.forEach(el => {
    if (el.getAttribute('onclick') && el.getAttribute('onclick').includes(`'${page}'`)) {
      el.classList.add('active');
    }
  });

  // 견적 수정 모드 해제 (견적 등록 외 페이지 이동 시)
  if (page !== 'reg-quotation' && window._editingQuotNo) {
    window._editingQuotNo = null;
    const sb = document.getElementById('quot-save-btn');
    if (sb) { sb.textContent = '💾 저장'; delete sb.dataset.editno; }
  }
  // 상단 타이틀
  const meta = PAGE_META[page] || { title: page, sub: '' };
  document.getElementById('topbar-title').textContent = meta.title;
  document.getElementById('topbar-sub').textContent   = meta.sub;
  document.getElementById('topbar-actions').innerHTML = '';

  // 페이지 렌더
  const content = document.getElementById('content');
  switch(page) {
    case 'dashboard':         renderDashboard(content);       break;
    case 'settings-staff':    renderSettingsStaff(content);   break;
    case 'settings-vendor':   renderSettingsVendor(content);  break;
    case 'settings-project':  renderSettingsProject(content); break;
    case 'settings-currency': renderSettingsCurrency(content);break;
    case 'settings-unit':     renderSettingsUnit(content);    break;
    case 'settings-category': renderSettingsCategory(content);break;
    case 'settings-division': renderSettingsDivision(content);break;
    case 'settings-codes':    renderSettingsCodes(content);    break;
    case 'master-parts':      renderMasterParts(content);     break;
    case 'master-equipment':  renderMasterEquip(content);     break;
    case 'reg-quotation':     renderRegQuotation(content);    break;
    case 'reg-purchase':      renderRegPurchase(content);     break;
    case 'reg-sales':         renderRegSales(content);        break;
    case 'list-quotation':    renderListQuotation(content);   break;
    case 'list-purchase':     renderListPurchase(content);    break;
    case 'list-sales':        renderListSales(content);       break;
    default: content.innerHTML = '<p class="text-muted">준비 중</p>';
  }
}

// ═══════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════
function showToast(msg, type = 'success', duration = 3000) {
  const tc   = document.getElementById('toast-container');
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${msg}</span>`;
  tc.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── 전역 로딩 오버레이 ─────────────────────────────────────
// HTML에 <div id="global-overlay" class="loading-overlay" style="display:none">
//   <div class="spinner"></div></div> 가 있어야 합니다.
// 없으면 동적으로 생성합니다.
let _overlayDepth = 0;

function showOverlay() {
  _overlayDepth++;
  let ov = document.getElementById('global-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'global-overlay';
    ov.style.cssText = [
      'position:fixed','inset:0','background:rgba(0,0,0,.45)',
      'display:flex','align-items:center','justify-content:center',
      'z-index:9000','transition:opacity .15s',
    ].join(';');
    ov.innerHTML = '<div class="spinner" style="width:40px;height:40px;border-width:4px"></div>';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
}

function hideOverlay() {
  _overlayDepth = Math.max(0, _overlayDepth - 1);
  if (_overlayDepth === 0) {
    const ov = document.getElementById('global-overlay');
    if (ov) ov.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
async function renderDashboard(el) {
  el.innerHTML = `<div style="position:relative;min-height:200px">
    <div class="loading-overlay"><div class="spinner"></div></div>
  </div>`;

  try {
    const d = await api({ action: 'getDashboard' });
    const s = d.stats || {};
    const monthly = d.monthly || [];

    el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card stat-blue">
        <div class="stat-label">Parts 등록</div>
        <div class="stat-value" style="color:var(--accent)">${s.totalParts || 0}</div>
        <div class="stat-sub">활성 부품</div>
      </div>
      <div class="stat-card stat-orange">
        <div class="stat-label">Equipment 등록</div>
        <div class="stat-value" style="color:var(--orange-light)">${s.totalEquip || 0}</div>
        <div class="stat-sub">활성 장비</div>
      </div>
      <div class="stat-card stat-yellow">
        <div class="stat-label">견적 (이번달)</div>
        <div class="stat-value" style="color:var(--yellow-light)">${s.quotThisMonth || 0}</div>
        <div class="stat-sub">전체 ${s.totalQuots || 0}건</div>
      </div>
      <div class="stat-card stat-green">
        <div class="stat-label">거래 (이번달)</div>
        <div class="stat-value" style="color:var(--green-light)">${s.salesThisMonth || 0}</div>
        <div class="stat-sub">전체 ${s.totalSales || 0}건</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">최근 6개월 거래 현황</div>
      </div>
      <div style="overflow-x:auto">
        <table style="min-width:500px">
          <thead>
            <tr>
              <th>월</th>
              <th style="text-align:right">구매 합계</th>
              <th style="text-align:right">판매 합계</th>
            </tr>
          </thead>
          <tbody>
            ${monthly.length ? monthly.map(m => `
              <tr>
                <td class="td-mono">${m.label}</td>
                <td style="text-align:right; color:var(--orange-light)">${fmtAmt(m.purchase)}</td>
                <td style="text-align:right; color:var(--green-light)">${fmtAmt(m.sale)}</td>
              </tr>
            `).join('') : '<tr><td colspan="3" class="table-empty">데이터 없음</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = `<div class="card"><p class="text-muted" style="padding:24px">대시보드 로드 실패: ${e.message}</p></div>`;
    showToast('대시보드 데이터 로드 실패 — ' + e.message, 'error');
  }
}

function fmtAmt(n) {
  if (!n) return '—';
  return Number(n).toLocaleString('ko-KR') + ' KRW';
}

// ═══════════════════════════════════════════════════════
// SETTINGS - 공통 CRUD 렌더러
// ═══════════════════════════════════════════════════════

// ── 공통: 설정항목 삭제 (행 완전 삭제) ───────────────────────
async function deleteSetting(sheet, id, idField, label, reloadFn) {
  if (!confirm(`"${label}"을(를) 완전히 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await api({ action: 'deleteSetting', sheet, id, idField });
    showToast(`${label} 삭제됨`);
    reloadFn();
  } catch(e) { showToast('삭제 실패: ' + e.message, 'error'); }
}
function deletePartById(btn) {
  const id    = btn.getAttribute('data-id');
  const label = btn.getAttribute('data-label') || id;
  deleteSetting('Parts', id, 'PartNo', label, loadPartsTable);
}
function deleteEquipById(btn) {
  const id    = btn.getAttribute('data-id');
  const label = btn.getAttribute('data-label') || id;
  deleteSetting('Equipment', id, 'EquipNo', label, loadEquipTable);
}


function renderSettingsPage(el, config) {
  el.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div class="card-title">${config.title}</div>
      <button class="btn btn-primary btn-sm" onclick="${config.addFn}()">+ 추가</button>
    </div>
    <div id="${config.tableId}">
      <div style="padding:40px;text-align:center"><div class="spinner" style="margin:0 auto"></div></div>
    </div>
  </div>`;
  config.loadFn();
}

// ─── 직원 관리 ───────────────────────────────────────────
async function renderSettingsStaff(el) {
  renderSettingsPage(el, { title:'직원 관리', tableId:'staff-table', addFn:'openStaffModal', loadFn:loadStaffTable });
}
async function loadStaffTable() {
  const el = document.getElementById('staff-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Staff' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 직원이 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>ID</th><th>이름</th><th>부서</th><th>직급</th>
        <th>연락처</th><th>이메일</th><th>상태</th><th>등록일</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td><strong>${r['이름']||''}</strong></td>
          <td class="td-muted">${r['부서']||''}</td>
          <td class="td-muted">${r['직급']||''}</td>
          <td class="td-muted">${r['연락처']||''}</td>
          <td class="td-muted">${r['이메일']||''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td class="td-muted text-sm">${fmtDate(r['등록일'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openStaffModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Staff","${r['ID']}","ID","${r['이름']||r['ID']}",loadStaffTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openStaffModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'직원 수정':'직원 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">이름 <span class="req">*</span></label>
          <input class="form-input" id="f-name" value="${d['이름']||''}" placeholder="홍길동">
        </div>
        <div class="form-group">
          <label class="form-label">부서</label>
          <input class="form-input" id="f-dept" value="${d['부서']||''}" placeholder="영업팀">
        </div>
        <div class="form-group">
          <label class="form-label">직급</label>
          <input class="form-input" id="f-rank" value="${d['직급']||''}" placeholder="과장">
        </div>
        <div class="form-group">
          <label class="form-label">연락처</label>
          <input class="form-input" id="f-tel" value="${d['연락처']||''}" placeholder="010-0000-0000">
        </div>
        <div class="form-group">
          <label class="form-label">이메일</label>
          <input class="form-input" id="f-email" value="${d['이메일']||''}" placeholder="hong@company.com">
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-use">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('ST-'+Date.now()),'이름':val('f-name'),'부서':val('f-dept'),
        '직급':val('f-rank'),'연락처':val('f-tel'),'이메일':val('f-email'),'사용여부':val('f-use'),'등록일':d['등록일']||''};
      if(!row['이름']){showToast('이름을 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Staff',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Staff',row});showToast('추가되었습니다');}
      await refreshCache('staff'); loadStaffTable();
    }
  });
}

// ─── 공급사 관리 ──────────────────────────────────────────
async function renderSettingsVendor(el) {
  renderSettingsPage(el, { title:'공급사/거래처 관리', tableId:'vendor-table', addFn:'openVendorModal', loadFn:loadVendorTable });
}
async function loadVendorTable() {
  const el = document.getElementById('vendor-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Vendor' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 공급사가 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>ID</th><th>회사명</th><th>구분</th><th>담당자</th>
        <th>연락처</th><th>이메일</th><th>상태</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td><strong>${r['회사명']||''}</strong></td>
          <td>${badgeVendorType(r['구분'])}</td>
          <td class="td-muted">${r['담당자']||''}</td>
          <td class="td-muted">${r['연락처']||''}</td>
          <td class="td-muted">${r['이메일']||''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openVendorModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Vendor","${r['ID']}","ID","${r['회사명']||r['ID']}",loadVendorTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openVendorModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'공급사 수정':'공급사 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">회사명 <span class="req">*</span></label>
          <input class="form-input" id="f-company" value="${d['회사명']||''}" placeholder="(주)협력사">
        </div>
        <div class="form-group">
          <label class="form-label">구분</label>
          <select class="form-select" id="f-type">
            <option value="공급사"  ${d['구분']==='공급사'?'selected':''}>공급사</option>
            <option value="고객사"  ${d['구분']==='고객사'?'selected':''}>고객사</option>
            <option value="협력사"  ${d['구분']==='협력사'?'selected':''}>협력사</option>
            <option value="기타"    ${d['구분']==='기타'?'selected':''}>기타</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">담당자</label>
          <input class="form-input" id="f-contact" value="${d['담당자']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">연락처</label>
          <input class="form-input" id="f-tel" value="${d['연락처']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">이메일</label>
          <input class="form-input" id="f-email" value="${d['이메일']||''}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">주소</label>
          <input class="form-input" id="f-addr" value="${d['주소']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">비고</label>
          <input class="form-input" id="f-note" value="${d['비고']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-use">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('V-'+Date.now()),'회사명':val('f-company'),'구분':val('f-type'),
        '담당자':val('f-contact'),'연락처':val('f-tel'),'이메일':val('f-email'),
        '주소':val('f-addr'),'비고':val('f-note'),'사용여부':val('f-use'),'등록일':d['등록일']||''};
      if(!row['회사명']){showToast('회사명을 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Vendor',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Vendor',row});showToast('추가되었습니다');}
      await refreshCache('vendor'); loadVendorTable();
    }
  });
}

// ─── 프로젝트 관리 ────────────────────────────────────────
async function renderSettingsProject(el) {
  renderSettingsPage(el, { title:'프로젝트 관리', tableId:'project-table', addFn:'openProjectModal', loadFn:loadProjectTable });
}
async function loadProjectTable() {
  const el = document.getElementById('project-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Project' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 프로젝트가 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>ID</th><th>코드</th><th>프로젝트명</th><th>고객사</th>
        <th>시작일</th><th>종료일</th><th>상태</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td class="td-mono">${r['프로젝트코드']||''}</td>
          <td><strong>${r['프로젝트명']||''}</strong></td>
          <td class="td-muted">${r['고객사']||''}</td>
          <td class="td-muted text-sm">${r['시작일']||''}</td>
          <td class="td-muted text-sm">${r['종료일']||''}</td>
          <td>${badgeProjectStatus(r['상태'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openProjectModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Project","${r['ID']}","ID","${r['프로젝트명']||r['ID']}",loadProjectTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openProjectModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'프로젝트 수정':'프로젝트 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">프로젝트코드</label>
          <input class="form-input" id="f-code" value="${d['프로젝트코드']||''}" placeholder="PRJ-2025-001">
        </div>
        <div class="form-group">
          <label class="form-label">프로젝트명 <span class="req">*</span></label>
          <input class="form-input" id="f-pname" value="${d['프로젝트명']||''}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">고객사</label>
          <input class="form-input" id="f-client" value="${d['고객사']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">시작일</label>
          <input class="form-input" type="date" id="f-start" value="${d['시작일']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">종료일</label>
          <input class="form-input" type="date" id="f-end" value="${d['종료일']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">상태</label>
          <select class="form-select" id="f-status">
            <option value="진행중" ${d['상태']==='진행중'||!isEdit?'selected':''}>진행중</option>
            <option value="완료"   ${d['상태']==='완료'?'selected':''}>완료</option>
            <option value="보류"   ${d['상태']==='보류'?'selected':''}>보류</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">비고</label>
          <input class="form-input" id="f-note" value="${d['비고']||''}">
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('P-'+Date.now()),'프로젝트코드':val('f-code'),'프로젝트명':val('f-pname'),
        '고객사':val('f-client'),'시작일':val('f-start'),'종료일':val('f-end'),
        '상태':val('f-status'),'비고':val('f-note'),'등록일':d['등록일']||''};
      if(!row['프로젝트명']){showToast('프로젝트명을 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Project',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Project',row});showToast('추가되었습니다');}
      await refreshCache('project'); loadProjectTable();
    }
  });
}

// ─── 통화 관리 ────────────────────────────────────────────
async function renderSettingsCurrency(el) {
  renderSettingsPage(el, { title:'통화 관리', tableId:'currency-table', addFn:'openCurrencyModal', loadFn:loadCurrencyTable });
}
async function loadCurrencyTable() {
  const el = document.getElementById('currency-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Currency' });
    const rows = d.rows || [];
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>통화코드</th><th>통화명</th><th>사용여부</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td class="td-mono" style="font-weight:600">${r['통화코드']||''}</td>
          <td>${r['통화명']||''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openCurrencyModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Currency","${r['ID']}","ID","${r['통화코드']||r['ID']}",loadCurrencyTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openCurrencyModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'통화 수정':'통화 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">통화코드 <span class="req">*</span></label>
          <input class="form-input" id="f-code" value="${d['통화코드']||''}" placeholder="USD" style="text-transform:uppercase">
        </div>
        <div class="form-group">
          <label class="form-label">통화명</label>
          <input class="form-input" id="f-name" value="${d['통화명']||''}" placeholder="미국달러">
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-use">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('C-'+Date.now()),'통화코드':val('f-code').toUpperCase(),'통화명':val('f-name'),'사용여부':val('f-use')};
      if(!row['통화코드']){showToast('통화코드를 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Currency',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Currency',row});showToast('추가되었습니다');}
      loadCurrencyTable();
    }
  });
}

// ─── 단위 관리 ────────────────────────────────────────────
async function renderSettingsUnit(el) {
  renderSettingsPage(el, { title:'단위 관리', tableId:'unit-table', addFn:'openUnitModal', loadFn:loadUnitTable });
}
async function loadUnitTable() {
  const el = document.getElementById('unit-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Unit' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 단위가 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>단위코드</th><th>단위명</th><th>적용대상</th><th>사용여부</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td class="td-mono" style="font-weight:600">${r['단위코드']||''}</td>
          <td>${r['단위명']||''}</td>
          <td>${r['적용대상'] ? `<span class="badge badge-blue">${r['적용대상']}</span>` : ''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openUnitModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Unit","${r['ID']}","ID","${r['단위코드']||r['ID']}",loadUnitTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openUnitModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'단위 수정':'단위 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">단위코드 <span class="req">*</span></label>
          <input class="form-input" id="f-ucode" value="${d['단위코드']||''}" placeholder="EA">
        </div>
        <div class="form-group">
          <label class="form-label">단위명</label>
          <input class="form-input" id="f-uname" value="${d['단위명']||''}" placeholder="개">
        </div>
        <div class="form-group">
          <label class="form-label">적용대상</label>
          <select class="form-select" id="f-utarget">
            <option value="공통"        ${(d['적용대상']||'공통')==='공통'?'selected':''}>공통 (Parts+Equipment)</option>
            <option value="Parts"       ${d['적용대상']==='Parts'?'selected':''}>Parts 전용</option>
            <option value="Equipment"   ${d['적용대상']==='Equipment'?'selected':''}>Equipment 전용</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-uuse">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('U-'+Date.now()),'단위코드':val('f-ucode'),'단위명':val('f-uname'),
        '적용대상':val('f-utarget'),'사용여부':val('f-uuse')};
      if(!row['단위코드']){showToast('단위코드를 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Unit',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Unit',row});showToast('추가되었습니다');}
      await refreshCache('unit'); loadUnitTable();
    }
  });
}

// ─── 카테고리 관리 ────────────────────────────────────────
async function renderSettingsCategory(el) {
  renderSettingsPage(el, { title:'카테고리 관리', tableId:'category-table', addFn:'openCategoryModal', loadFn:loadCategoryTable });
}
async function loadCategoryTable() {
  const el = document.getElementById('category-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Category' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 카테고리가 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>카테고리명</th><th>적용대상</th><th>설명</th><th>사용여부</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td><strong>${r['카테고리명']||''}</strong></td>
          <td>${r['적용대상'] ? `<span class="badge badge-orange">${r['적용대상']}</span>` : ''}</td>
          <td class="td-muted text-sm">${r['설명']||''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openCategoryModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Category","${r['ID']}","ID","${r['카테고리명']||r['ID']}",loadCategoryTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openCategoryModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'카테고리 수정':'카테고리 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">카테고리명 <span class="req">*</span></label>
          <input class="form-input" id="f-cname" value="${d['카테고리명']||''}" placeholder="전장품">
        </div>
        <div class="form-group">
          <label class="form-label">적용대상</label>
          <select class="form-select" id="f-ctarget">
            <option value="공통"        ${(d['적용대상']||'공통')==='공통'?'selected':''}>공통 (Parts+Equipment)</option>
            <option value="Parts"       ${d['적용대상']==='Parts'?'selected':''}>Parts 전용</option>
            <option value="Equipment"   ${d['적용대상']==='Equipment'?'selected':''}>Equipment 전용</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">설명</label>
          <input class="form-input" id="f-cdesc" value="${d['설명']||''}" placeholder="예: 모터, 드라이브 등 전기 관련 부품">
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-cuse">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('CAT-'+Date.now()),'카테고리명':val('f-cname'),
        '적용대상':val('f-ctarget'),'설명':val('f-cdesc'),'사용여부':val('f-cuse')};
      if(!row['카테고리명']){showToast('카테고리명을 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Category',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Category',row});showToast('추가되었습니다');}
      await refreshCache('category'); loadCategoryTable();
    }
  });
}

// ─── 구분 관리 ────────────────────────────────────────────
async function renderSettingsDivision(el) {
  renderSettingsPage(el, { title:'구분 관리', tableId:'division-table', addFn:'openDivisionModal', loadFn:loadDivisionTable });
}
async function loadDivisionTable() {
  const el = document.getElementById('division-table');
  if (!el) return;
  try {
    const d = await api({ action:'getSettings', sheet:'Settings_Division' });
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML='<div class="table-empty">등록된 구분이 없습니다</div>'; return; }
    el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>구분명</th><th>적용위치</th><th>설명</th><th>사용여부</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td class="td-mono">${r['ID']||''}</td>
          <td><strong>${r['구분명']||''}</strong></td>
          <td>${r['적용위치'] ? `<span class="badge badge-yellow">${r['적용위치']}</span>` : ''}</td>
          <td class="td-muted text-sm">${r['설명']||''}</td>
          <td>${badgeYN(r['사용여부'])}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick='openDivisionModal(${JSON.stringify(r)})'>수정</button>
              <button class="btn btn-danger btn-sm" onclick='deleteSetting("Settings_Division","${r['ID']}","ID","${r['구분명']||r['ID']}",loadDivisionTable)'>삭제</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('데이터 로드 실패 — ' + e.message, 'error');
  }
}
function openDivisionModal(data=null) {
  const isEdit=!!data, d=data||{};
  showModal({
    title: isEdit?'구분 수정':'구분 추가',
    body:`
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">구분명 <span class="req">*</span></label>
          <input class="form-input" id="f-dname" value="${d['구분명']||''}" placeholder="예: Shuttle, 외주, 인건비">
        </div>
        <div class="form-group">
          <label class="form-label">적용위치</label>
          <select class="form-select" id="f-dloc">
            <option value="공통"        ${(d['적용위치']||'공통')==='공통'?'selected':''}>공통 (견적+구매+판매)</option>
            <option value="견적"        ${d['적용위치']==='견적'?'selected':''}>견적 전용</option>
            <option value="구매판매"    ${d['적용위치']==='구매판매'?'selected':''}>구매/판매 전용</option>
            <option value="Parts"       ${d['적용위치']==='Parts'?'selected':''}>Parts 전용</option>
            <option value="Equipment"   ${d['적용위치']==='Equipment'?'selected':''}>Equipment 전용</option>
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">설명</label>
          <input class="form-input" id="f-ddesc" value="${d['설명']||''}" placeholder="설명 (선택)">
        </div>
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-duse">
            <option value="Y" ${d['사용여부']==='Y'||!isEdit?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>
      </div>`,
    onConfirm: async()=>{
      const row={'ID':d['ID']||('DIV-'+Date.now()),'구분명':val('f-dname'),
        '적용위치':val('f-dloc'),'설명':val('f-ddesc'),'사용여부':val('f-duse')};
      if(!row['구분명']){showToast('구분명을 입력하세요','error');return false;}
      if(isEdit){await api({action:'updateSetting',sheet:'Settings_Division',id:d['ID'],idField:'ID',row});showToast('수정되었습니다');}
      else{await api({action:'addSetting',sheet:'Settings_Division',row});showToast('추가되었습니다');}
      await refreshCache('division'); loadDivisionTable();
    }
  });
}

// ═══════════════════════════════════════════════════════
// 코드 관리 (통화 / 단위 / 카테고리 / 구분 통합 탭)
// ═══════════════════════════════════════════════════════
function renderSettingsCodes(el) {
  el.innerHTML = `
  <div class="card">
    <div class="tabs" id="codes-tabs">
      <button class="tab-btn active" onclick="switchCodesTab('currency',this)">💱 통화</button>
      <button class="tab-btn"        onclick="switchCodesTab('unit',this)">📐 단위</button>
      <button class="tab-btn"        onclick="switchCodesTab('category',this)">🏷️ 카테고리</button>
      <button class="tab-btn"        onclick="switchCodesTab('division',this)">📂 구분</button>
    </div>

    <!-- 탭별 패널 -->
    <div id="codes-panel-currency">
      <div class="card-header" style="padding:0 0 14px 0">
        <div class="card-title">통화 관리</div>
        <button class="btn btn-primary btn-sm" onclick="openCurrencyModal()">+ 추가</button>
      </div>
      <div id="currency-table">
        <div style="padding:32px;text-align:center"><div class="spinner" style="margin:0 auto"></div></div>
      </div>
    </div>

    <div id="codes-panel-unit" style="display:none">
      <div class="card-header" style="padding:0 0 14px 0">
        <div class="card-title">단위 관리</div>
        <button class="btn btn-primary btn-sm" onclick="openUnitModal()">+ 추가</button>
      </div>
      <div id="unit-table"></div>
    </div>

    <div id="codes-panel-category" style="display:none">
      <div class="card-header" style="padding:0 0 14px 0">
        <div class="card-title">카테고리 관리</div>
        <button class="btn btn-primary btn-sm" onclick="openCategoryModal()">+ 추가</button>
      </div>
      <div id="category-table"></div>
    </div>

    <div id="codes-panel-division" style="display:none">
      <div class="card-header" style="padding:0 0 14px 0">
        <div class="card-title">구분 관리</div>
        <button class="btn btn-primary btn-sm" onclick="openDivisionModal()">+ 추가</button>
      </div>
      <div id="division-table"></div>
    </div>
  </div>`;

  // 첫 탭 로드
  loadCurrencyTable();
}

function switchCodesTab(tab, btn) {
  // 탭 버튼 활성화
  document.querySelectorAll('#codes-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // 패널 전환
  ['currency','unit','category','division'].forEach(t => {
    const p = document.getElementById('codes-panel-' + t);
    if (p) p.style.display = t === tab ? '' : 'none';
  });

  // 해당 탭 데이터 로드
  const loaders = {
    currency: loadCurrencyTable,
    unit:     loadUnitTable,
    category: loadCategoryTable,
    division: loadDivisionTable,
  };
  if (loaders[tab]) loaders[tab]();
}

// ═══════════════════════════════════════════════════════
// MASTER DB - PARTS
// ═══════════════════════════════════════════════════════
async function renderMasterParts(el) {
  el.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div class="card-title">🔩 Parts 목록</div>
      <div class="flex gap-2">
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input class="search-input" id="parts-search" placeholder="품명, 모델명, 제조사 검색..."
                 oninput="filterPartsTable(this.value)">
        </div>
        <button class="btn btn-primary btn-sm" onclick="openPartsModal()">+ 부품 추가</button>
      </div>
    </div>
    <div id="parts-table">
      <div style="padding:40px;text-align:center"><div class="spinner" style="margin:0 auto"></div></div>
    </div>
  </div>`;
  loadPartsTable();
}

let _partsData = [];

async function loadPartsTable() {
  const el = document.getElementById('parts-table');
  if (!el) return;
  try {
    const d = await api({ action: 'getParts' });
    _partsData = d.rows || [];
    renderPartsRows(_partsData);
    await refreshCache('parts');
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('Parts 데이터 로드 실패 — ' + e.message, 'error');
  }
}

function filterPartsTable(q) {
  _partsPage = 1;
  if (!q) { renderPartsRows(_partsData); return; }
  const lq = q.toLowerCase();
  renderPartsRows(_partsData.filter(r =>
    ['PartNo','품명','모델명','제조사','공급사명','카테고리'].some(f =>
      String(r[f]||'').toLowerCase().includes(lq))
  ));
}

function renderPartsRows(rows) {
  const el = document.getElementById('parts-table');
  if (!el) return;
  _partsDisplayRows = rows;
  if (!rows.length) {
    el.innerHTML = '<div class="table-empty">등록된 부품이 없습니다</div>'; return;
  }
  const pg = paginateRows(rows, _partsPage);
  _partsPage = pg.page;
  el.innerHTML = `
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Part No.</th><th>품명</th><th>모델명</th><th>제조사</th>
      <th>공급사</th><th>단위</th><th>표준단가</th><th>통화</th><th>카테고리</th><th>상태</th><th></th>
    </tr></thead>
    <tbody>
      ${pg.rows.map(r => `
      <tr>
        <td class="td-mono">${r['PartNo']||''}</td>
        <td><strong>${r['품명']||''}</strong></td>
        <td class="td-muted">${r['모델명']||''}</td>
        <td class="td-muted">${r['제조사']||''}</td>
        <td class="td-muted">${r['공급사명']||''}</td>
        <td class="td-muted">${r['단위']||''}</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; font-size:12px">
          ${r['표준단가'] ? Number(r['표준단가']).toLocaleString() : '—'}
        </td>
        <td class="td-muted">${r['통화']||''}</td>
        <td>${r['카테고리'] ? `<span class="badge badge-blue">${r['카테고리']}</span>` : ''}</td>
        <td>${badgeYN(r['사용여부'])}</td>
        <td>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" onclick='openPartsModal(${JSON.stringify(r)})'>수정</button>
            <button class="btn btn-danger btn-sm" onclick="deletePartById(this)"
              data-id="${r['PartNo']}" data-label="${r['품명']||r['PartNo']}">삭제</button>
          </div>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  ${renderPageBar(pg.total, pg.page, pg.pages, PAGE_SIZE, 'goPartsPage')}`;
}

function goPartsPage(p) { _partsPage = p; renderPartsRows(_partsDisplayRows); }

function openPartsModal(data = null) {
  const isEdit = !!data;
  const d = data || {};
  const vendorOpts = (CACHE.vendor || [])
    .map(v => `<option value="${v['ID']}" data-name="${v['회사명']}" ${d['공급사ID']===v['ID']?'selected':''}>${v['회사명']}</option>`)
    .join('');
  const currOpts = (CACHE.currency || [])
    .map(c => `<option value="${c['통화코드']}" ${(d['통화']||'KRW')===c['통화코드']?'selected':''}>${c['통화코드']} - ${c['통화명']}</option>`)
    .join('');

  showModal({
    title: isEdit ? `부품 수정 — ${d['PartNo']}` : '부품 추가',
    size: 'lg',
    body: `
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">품명 <span class="req">*</span></label>
          <input class="form-input" id="f-pname" value="${d['품명']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">모델명</label>
          <input class="form-input" id="f-model" value="${d['모델명']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">제조사</label>
          <input class="form-input" id="f-maker" value="${d['제조사']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">공급사</label>
          <select class="form-select" id="f-vendor" onchange="syncVendorName('f-vendor','f-vname')">
            <option value="">-- 선택 --</option>
            ${vendorOpts}
          </select>
          <input type="hidden" id="f-vname" value="${d['공급사명']||''}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">규격/사양</label>
          <input class="form-input" id="f-spec" value="${d['규격사양']||''}" placeholder="크기, 재질, 전압 등">
        </div>
        <div class="form-group">
          <label class="form-label">단위</label>
          <select class="form-select" id="f-unit">
            ${buildUnitOpts('Parts', d['단위']||'')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">카테고리</label>
          <select class="form-select" id="f-cat">
            ${buildCatOpts('Parts', d['카테고리']||'')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">표준단가</label>
          <input class="form-input" type="number" id="f-price" value="${d['표준단가']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">통화</label>
          <select class="form-select" id="f-currency">${currOpts}</select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">비고</label>
          <textarea class="form-textarea" id="f-note" style="min-height:60px">${d['비고']||''}</textarea>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-use">
            <option value="Y" ${d['사용여부']==='Y'?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>` : ''}
      </div>`,
    onConfirm: async () => {
      const vendorSel = document.getElementById('f-vendor');
      const vendorName = vendorSel.selectedIndex > 0
        ? vendorSel.options[vendorSel.selectedIndex].getAttribute('data-name') : '';
      const row = {
        '품명': val('f-pname'), '모델명': val('f-model'),
        '제조사': val('f-maker'), '공급사ID': val('f-vendor'),
        '공급사명': vendorName, '규격사양': val('f-spec'),
        '단위': val('f-unit'), '카테고리': val('f-cat'),
        '표준단가': val('f-price'), '통화': val('f-currency'),
        '비고': val('f-note'),
        '사용여부': isEdit ? val('f-use') : 'Y',
      };
      if (!row['품명']) { showToast('품명을 입력하세요', 'error'); return false; }
      if (isEdit) {
        row['PartNo'] = d['PartNo'];
        await api({ action: 'updatePart', id: d['PartNo'], row });
        showToast('부품 정보가 수정되었습니다');
      } else {
        await api({ action: 'addPart', row });
        showToast('부품이 추가되었습니다');
      }
      await refreshCache('parts');
      loadPartsTable();
    }
  });
}

// ═══════════════════════════════════════════════════════
// MASTER DB - EQUIPMENT
// ═══════════════════════════════════════════════════════
async function renderMasterEquip(el) {
  el.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div class="card-title">⚙️ Equipment 목록</div>
      <div class="flex gap-2">
        <div class="search-input-wrap">
          <span class="search-icon">🔍</span>
          <input class="search-input" id="equip-search" placeholder="장비명, 모델명, 제조사 검색..."
                 oninput="filterEquipTable(this.value)">
        </div>
        <button class="btn btn-primary btn-sm" onclick="openEquipModal()">+ 장비 추가</button>
      </div>
    </div>
    <div id="equip-table">
      <div style="padding:40px;text-align:center"><div class="spinner" style="margin:0 auto"></div></div>
    </div>
  </div>`;
  loadEquipTable();
}

let _equipData = [];

async function loadEquipTable() {
  const el = document.getElementById('equip-table');
  if (!el) return;
  try {
    const d = await api({ action: 'getEquipment' });
    _equipData = d.rows || [];
    renderEquipRows(_equipData);
    await refreshCache('equipment');
  } catch(e) {
    if (el) el.innerHTML = '<div class="table-empty">로드 실패</div>';
    showToast('Equipment 데이터 로드 실패 — ' + e.message, 'error');
  }
}

function filterEquipTable(q) {
  _equipPage = 1;
  if (!q) { renderEquipRows(_equipData); return; }
  const lq = q.toLowerCase();
  renderEquipRows(_equipData.filter(r =>
    ['EquipNo','장비명','모델명','제조사','공급사명','카테고리'].some(f =>
      String(r[f]||'').toLowerCase().includes(lq))
  ));
}

function renderEquipRows(rows) {
  const el = document.getElementById('equip-table');
  if (!el) return;
  _equipDisplayRows = rows;
  if (!rows.length) {
    el.innerHTML = '<div class="table-empty">등록된 장비가 없습니다</div>'; return;
  }
  const pg = paginateRows(rows, _equipPage);
  _equipPage = pg.page;
  el.innerHTML = `
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Equip No.</th><th>장비명</th><th>모델명</th><th>제조사</th>
      <th>공급사</th><th>용도/위치</th><th>표준단가</th><th>통화</th><th>상태</th><th></th>
    </tr></thead>
    <tbody>
      ${pg.rows.map(r => `
      <tr>
        <td class="td-mono">${r['EquipNo']||''}</td>
        <td><strong>${r['장비명']||''}</strong></td>
        <td class="td-muted">${r['모델명']||''}</td>
        <td class="td-muted">${r['제조사']||''}</td>
        <td class="td-muted">${r['공급사명']||''}</td>
        <td class="td-muted text-sm">${r['용도설치위치']||''}</td>
        <td style="text-align:right; font-family:'JetBrains Mono',monospace; font-size:12px">
          ${r['표준단가'] ? Number(r['표준단가']).toLocaleString() : '—'}
        </td>
        <td class="td-muted">${r['통화']||''}</td>
        <td>${badgeYN(r['사용여부'])}</td>
        <td>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" onclick='openEquipModal(${JSON.stringify(r)})'>수정</button>
            <button class="btn btn-danger btn-sm" onclick="deleteEquipById(this)"
                    data-id="${r['EquipNo']}" data-label="${r['장비명']||r['EquipNo']}">삭제</button>
          </div>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  ${renderPageBar(pg.total, pg.page, pg.pages, PAGE_SIZE, 'goEquipPage')}`;
}

function goEquipPage(p) { _equipPage = p; renderEquipRows(_equipDisplayRows); }

function openEquipModal(data = null) {
  const isEdit = !!data;
  const d = data || {};
  const vendorOpts = (CACHE.vendor || [])
    .map(v => `<option value="${v['ID']}" data-name="${v['회사명']}" ${d['공급사ID']===v['ID']?'selected':''}>${v['회사명']}</option>`)
    .join('');
  const currOpts = (CACHE.currency || [])
    .map(c => `<option value="${c['통화코드']}" ${(d['통화']||'KRW')===c['통화코드']?'selected':''}>${c['통화코드']} - ${c['통화명']}</option>`)
    .join('');

  showModal({
    title: isEdit ? `장비 수정 — ${d['EquipNo']}` : '장비 추가',
    size: 'lg',
    body: `
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">장비명 <span class="req">*</span></label>
          <input class="form-input" id="f-ename" value="${d['장비명']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">모델명</label>
          <input class="form-input" id="f-model" value="${d['모델명']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">제조사</label>
          <input class="form-input" id="f-maker" value="${d['제조사']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">공급사</label>
          <select class="form-select" id="f-vendor">
            <option value="">-- 선택 --</option>
            ${vendorOpts}
          </select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">규격/사양</label>
          <input class="form-input" id="f-spec" value="${d['규격사양']||''}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">용도/설치위치</label>
          <input class="form-input" id="f-loc" value="${d['용도설치위치']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">단위</label>
          <select class="form-select" id="f-unit">
            ${buildUnitOpts('Equipment', d['단위']||'')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">카테고리</label>
          <select class="form-select" id="f-cat">
            ${buildCatOpts('Equipment', d['카테고리']||'')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">표준단가</label>
          <input class="form-input" type="number" id="f-price" value="${d['표준단가']||''}">
        </div>
        <div class="form-group">
          <label class="form-label">통화</label>
          <select class="form-select" id="f-currency">${currOpts}</select>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">비고</label>
          <textarea class="form-textarea" id="f-note" style="min-height:60px">${d['비고']||''}</textarea>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">사용여부</label>
          <select class="form-select" id="f-use">
            <option value="Y" ${d['사용여부']==='Y'?'selected':''}>사용</option>
            <option value="N" ${d['사용여부']==='N'?'selected':''}>미사용</option>
          </select>
        </div>` : ''}
      </div>`,
    onConfirm: async () => {
      const vendorSel = document.getElementById('f-vendor');
      const vendorName = vendorSel.selectedIndex > 0
        ? vendorSel.options[vendorSel.selectedIndex].getAttribute('data-name') : '';
      const row = {
        '장비명': val('f-ename'), '모델명': val('f-model'),
        '제조사': val('f-maker'), '공급사ID': val('f-vendor'),
        '공급사명': vendorName, '규격사양': val('f-spec'),
        '용도설치위치': val('f-loc'), '단위': val('f-unit'),
        '카테고리': val('f-cat'), '표준단가': val('f-price'),
        '통화': val('f-currency'), '비고': val('f-note'),
        '사용여부': isEdit ? val('f-use') : 'Y',
      };
      if (!row['장비명']) { showToast('장비명을 입력하세요', 'error'); return false; }
      if (isEdit) {
        row['EquipNo'] = d['EquipNo'];
        await api({ action: 'updateEquip', id: d['EquipNo'], row });
        showToast('장비 정보가 수정되었습니다');
      } else {
        await api({ action: 'addEquipment', row });
        showToast('장비가 추가되었습니다');
      }
      await refreshCache('equipment');
      loadEquipTable();
    }
  });
}

// ═══════════════════════════════════════════════════════
// 견적 등록 (좌: 고객용 견적서 / 우: 내부 세부내역 + 연결 도구)
// ═══════════════════════════════════════════════════════
function renderRegQuotation(el, prefill = null) {
  const today = new Date().toISOString().slice(0,10);
  const vendorOpts = (CACHE.vendor||[]).map(v =>
    `<option value="${v['ID']}" data-name="${v['회사명']}">${v['회사명']}</option>`).join('');
  const projOpts = (CACHE.project||[]).map(p =>
    `<option value="${p['ID']}" data-name="${p['프로젝트명']}">${p['프로젝트명']}</option>`).join('');
  const staffOpts = (CACHE.staff||[]).map(s =>
    `<option value="${s['ID']}" data-name="${s['이름']}">${s['이름']} (${s['부서']||''})</option>`).join('');

  el.innerHTML = `
  

  <div class="card" style="margin-bottom:14px">
    <div class="card-header">
      <div class="card-title">📋 견적 등록</div>
      <div class="flex gap-2">
        <button class="btn btn-secondary btn-sm" onclick="navigate('list-quotation')">← 목록</button>
        <button class="btn btn-secondary btn-sm" onclick="openQuotSheet()" id="quot-sheet-btn">
          📄 고객용 견적서
          <span id="quot-sheet-badge" style="display:none;background:var(--green);color:#fff;
            border-radius:10px;padding:1px 7px;font-size:10px;margin-left:4px">0</span>
        </button>
        <button class="btn btn-success btn-sm" id="quot-save-btn" onclick="submitQuotation()">💾 저장</button>
      </div>
    </div>
    <div class="form-grid form-grid-3">
      <div class="form-group">
        <label class="form-label">견적일 <span class="req">*</span></label>
        <input class="form-input" type="date" id="q-date" value="${today}">
      </div>
      <div class="form-group">
        <label class="form-label">공급사 <span class="req">*</span></label>
        <select class="form-select" id="q-vendor">
          <option value="">-- 선택 --</option>${vendorOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">유효기간</label>
        <input class="form-input" type="date" id="q-expire">
      </div>
      <div class="form-group">
        <label class="form-label">프로젝트</label>
        <select class="form-select" id="q-project">
          <option value="">-- 선택 --</option>${projOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">담당자</label>
        <select class="form-select" id="q-staff">
          <option value="">-- 선택 --</option>${staffOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">상태</label>
        <select class="form-select" id="q-status">
          <option value="진행중">진행중</option>
          <option value="완료">완료</option>
          <option value="취소">취소</option>
        </select>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">비고</label>
        <input class="form-input" id="q-note" placeholder="메모">
      </div>
    </div>
  </div>

  <div class="quot-workspace">

    <!-- ═══ 고객용 견적서 팝업 버튼 ═══ -->
    <!-- ═══ 오른쪽(전체폭): 세부내역 + 연결 ═══ -->
    <div class="quot-right" style="width:100%">

      <!-- 세부내역 -->
      <div class="card">
        <div class="card-header" style="margin-bottom:10px">
          <div class="card-title">📊 내부 세부내역</div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" onclick="addDetailRow()">+ 행 추가</button>
            <button class="btn btn-secondary btn-sm" onclick="addDetailSubtotal()">+ 소계 행</button>
            <button class="btn btn-secondary btn-sm" style="font-size:11px;color:var(--text3)"
                    onclick="resetDetailColWidths()" title="컬럼 너비 초기화">↺</button>
          </div>
        </div>
        <div class="dt-wrap">
          <table class="dt-table" id="detail-table" data-resize-id="detail-table">
            <thead><tr>
              <th style="width:30px">No.</th>
              <th style="width:90px">견적서No.</th>
              <th style="width:90px">구분</th>
              <th style="width:120px">품번</th>
              <th style="width:160px">품명</th>
              <th style="width:50px">단위</th>
              <th style="width:55px">통화</th>
              <th style="width:100px">외화단가</th>
              <th style="width:55px">수량</th>
              <th style="width:100px">외화원가</th>
              <th style="width:55px">할인율</th>
              <th style="width:100px">외화할인가</th>
              <th style="width:55px">환율</th>
              <th style="width:100px">단가(₩)</th>
              <th style="width:110px">금액(₩)</th>
              <th style="width:110px">할인금액(₩)</th>
              <th style="width:55px">익율</th>
              <th style="width:110px" style="background:rgba(37,99,235,0.1)">견적가(₩) Y</th>
              <th style="width:110px">할인견적가(₩)</th>
              <th style="width:80px">비고</th>
              <th style="width:40px"></th>
            </tr></thead>
            <tbody id="detail-rows"></tbody>
          </table>
        </div>
        <div class="flex" style="justify-content:flex-end;gap:20px;padding:10px 4px 0">
          <span style="font-size:12px;color:var(--text2)">견적가 합계</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:var(--accent)" id="detail-total">—</span>
        </div>
      </div>
    </div>
  </div>`;

  // 수정 모드(window._pendingEditData가 있음)가 아닐 때만 초기화
  if (!window._pendingEditData) {
    _qClientIdx  = 0;
    _qDetailIdx  = 0;
    _qSheetRows  = [];
    _qLinkRules  = [];
    clearQsStorage();
    addDetailRow();  // 신규: 빈 행 1개
  }
  // 수정 모드면 _applyPendingEdit()이 데이터를 채움 (navigate 완료 후 호출됨)
}

// 고객용 견적서 관련 localStorage 전체 초기화
function clearQsStorage() {
  try {
    localStorage.removeItem('sgintech_quot_sheet_saved');
    localStorage.removeItem('sgintech_quot_sheet_data');   // QS_WINDOW_KEY
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════
// 고객용 견적서 팝업
// ═══════════════════════════════════════════════════════
let _qClientIdx = 0;
let _qSheetRows = [];
// 각 행: { id, type:'group'|'item'|'total', no, name, spec, unit, qty, amt, note, linkedAmt }

/* ── 팝업 오픈 ── */
// 새창에 데이터 전달용 LS 키
const QS_WINDOW_KEY = 'sgintech_quot_sheet_data';
let _qsWindow = null;

function openQuotSheet() {
  // 현재 데이터를 localStorage에 직렬화해서 저장
  pushQsDataToStorage();
  // 창 열기 전 드롭다운 먼저 갱신 (이미 저장된 데이터 반영)
  refreshQsNoDropdowns();

  // 이미 창이 열려있으면 포커스 + 데이터 동기화
  if (_qsWindow && !_qsWindow.closed) {
    _qsWindow.focus();
    pushQsDataToStorage();
    _qsWindow.postMessage({ type: 'QS_UPDATE' }, '*');
    return;
  }

  // 새창 열기 (800×700)
  const w = 920, h = 720;
  const left = Math.round(window.screenX + (window.outerWidth  - w) / 2);
  const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);
  _qsWindow = window.open(
    '',
    'quot_sheet_window',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );

  if (!_qsWindow) {
    showToast('팝업이 차단되었습니다. 브라우저 팝업 허용 후 다시 시도하세요.', 'error');
    return;
  }

  // Blob URL 방식: <style> 태그를 포함한 HTML을 안전하게 새창에 로드
  const htmlContent = buildQsWindowHtml();
  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  _qsWindow.location.href = blobUrl;
  // Blob URL은 창이 로드된 후 revoke
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

// 세부내역 변경 시 새창에 반영 (applyAllLinkRules에서 호출)
function syncQsWindow() {
  pushQsDataToStorage();
  // 새창에 postMessage로 업데이트 알림
  if (_qsWindow && !_qsWindow.closed) {
    _qsWindow.postMessage({ type: 'QS_UPDATE' }, '*');
  }
}

function pushQsDataToStorage() {
  const plant    = document.getElementById('qs-plant')?.value    || '';
  const projname = document.getElementById('qs-projname')?.value || '';
  const payload  = JSON.stringify({ rows: _qSheetRows, plant, projname, ts: Date.now() });
  try {
    // QS_WINDOW_KEY: 새창에 전달용
    localStorage.setItem(QS_WINDOW_KEY, payload);
    // SAVE_KEY: getQsRows 1순위 — 부모창 데이터로 덮어씌워 id 불일치 방지
    localStorage.setItem('sgintech_quot_sheet_saved', payload);
  } catch(e) {}
}

// 새창에서 저장된 rows를 부모창 _qSheetRows에 병합
// no, name, spec, unit, qty, amt, note를 새창 데이터로 업데이트
// id는 부모창 것을 유지 (드롭다운 value와 일치)
function _mergeQsRowsFromWindow(windowRows) {
  if (!windowRows || !windowRows.length) return;
  if (!_qSheetRows.length) {
    // _qSheetRows가 비어있으면 새창 rows를 그대로 사용
    _qSheetRows = windowRows.map((r, i) => ({ ...r }));
    return;
  }
  // 순번(index) 기준으로 데이터 병합
  windowRows.forEach((wr, i) => {
    if (_qSheetRows[i]) {
      _qSheetRows[i].no   = wr.no   || _qSheetRows[i].no;
      _qSheetRows[i].name = wr.name || _qSheetRows[i].name;
      _qSheetRows[i].spec = wr.spec || _qSheetRows[i].spec;
      _qSheetRows[i].unit = wr.unit || _qSheetRows[i].unit;
      _qSheetRows[i].qty  = wr.qty  != null ? wr.qty  : _qSheetRows[i].qty;
      _qSheetRows[i].amt  = wr.amt  != null ? wr.amt  : _qSheetRows[i].amt;
      _qSheetRows[i].note = wr.note || _qSheetRows[i].note;
      _qSheetRows[i].type = wr.type || _qSheetRows[i].type;
    } else {
      // 새창에서 추가된 행
      _qSheetRows.push({ ...wr, id: 'rc-new-' + i + '-' + Date.now() });
    }
  });
  // 새창에서 삭제된 행 제거
  if (windowRows.length < _qSheetRows.length) {
    _qSheetRows = _qSheetRows.slice(0, windowRows.length);
  }
}

function buildQsWindowHtml() {
  const ST = '<'+'style>'; const STC = '<'+'/style>'; const SC = '<'+'script>'; const SCC = '<'+'/script>';
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>고객용 견적서 — 신강인테크</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
${ST}
  :root {
    --bg:#0d1117; --bg2:#161b22; --bg3:#1c2128;
    --border:#30363d; --border2:#21262d;
    --text:#e6edf3; --text2:#8b949e; --text3:#484f58;
    --accent:#2563eb; --accent-glow:#2563eb40;
    --green-light:#3fb950; --red-light:#f85149;
  }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Noto Sans KR',sans-serif; background:var(--bg); color:var(--text);
         font-size:13px; padding:0; }

  /* 툴바 */
  .toolbar {
    position:sticky; top:0; z-index:100;
    background:var(--bg2); border-bottom:1px solid var(--border2);
    padding:10px 16px; display:flex; align-items:center; gap:10px;
  }
  .toolbar-title { font-size:14px; font-weight:700; flex:1; }
  .btn { display:inline-flex; align-items:center; gap:5px; padding:6px 12px;
         border-radius:6px; font-size:12px; font-weight:500; border:none; cursor:pointer;
         font-family:inherit; transition:all .15s; }
  .btn-primary   { background:var(--accent); color:#fff; }
  .btn-primary:hover { background:#1d4ed8; }
  .btn-secondary { background:var(--bg3); color:var(--text); border:1px solid var(--border); }
  .btn-secondary:hover { background:var(--border); }
  .btn-success   { background:#238636; color:#fff; }
  .btn-success:hover { background:#196c2e; }
  .btn-danger    { background:transparent; color:var(--red-light); border:1px solid var(--border); }
  .btn-danger:hover { background:rgba(248,81,73,.1); border-color:var(--red-light); }
  .btn-sm { padding:4px 9px; font-size:11px; }

  /* 프로젝트 정보 */
  .proj-info {
    background:var(--bg3); border-bottom:1px solid var(--border2);
    padding:10px 16px; display:flex; gap:12px; flex-wrap:wrap;
  }
  .proj-field { display:flex; align-items:center; gap:8px; flex:1; min-width:180px; }
  .proj-label { font-size:11px; color:var(--text2); white-space:nowrap; min-width:80px; }
  .proj-input {
    flex:1; padding:5px 10px; background:var(--bg2); border:1px solid var(--border);
    border-radius:5px; color:var(--text); font-size:12px; outline:none;
    font-family:inherit;
  }
  .proj-input:focus { border-color:var(--accent); }

  /* 견적서 테이블 */
  .main { padding:16px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th {
    background:var(--bg3); color:var(--text2); font-size:11px; font-weight:600;
    padding:8px 8px; border:1px solid var(--border2); text-align:center; white-space:nowrap;
  }
  td { padding:6px 8px; border:1px solid var(--border2); vertical-align:middle; }
  tr.group-row td {
    background:var(--bg3); font-weight:600; font-size:13px;
  }
  tr.group-row td:first-child {
    color:var(--accent); font-family:'JetBrains Mono',monospace; text-align:center;
  }
  tr.total-row td { background:rgba(37,99,235,.06); font-weight:700; }
  .amt { text-align:right; font-family:'JetBrains Mono',monospace; font-weight:600; color:var(--accent); }
  .muted { color:var(--text2); }
  .center { text-align:center; }
  .ct-input {
    background:transparent; border:none; outline:none; color:var(--text);
    font-size:12px; width:100%; font-family:inherit;
  }
  .ct-input:focus { background:rgba(37,99,235,.08); border-radius:3px; }
  tr.group-row .ct-input { font-size:13px; font-weight:600; }
  .line-del-btn {
    background:none; border:none; color:var(--text3); cursor:pointer;
    font-size:14px; padding:1px 5px; transition:color .15s;
  }
  .line-del-btn:hover { color:var(--red-light); }

  /* 상태 배너 */
  #sync-banner {
    display:none; position:fixed; top:56px; right:12px;
    background:var(--accent); color:#fff; border-radius:6px;
    padding:6px 12px; font-size:12px; font-weight:500;
    box-shadow:0 2px 12px rgba(0,0,0,.4);
    animation: fadeIn .2s ease;
  }
  @keyframes fadeIn { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
${STC}
</head>
<body>

<div class="toolbar">
  <div class="toolbar-title">📄 고객용 견적서</div>
  <span style="font-size:11px;color:var(--text3)">Unit: ￦</span>
  <button class="btn btn-secondary btn-sm" onclick="addGroup()">+ 그룹</button>
  <button class="btn btn-secondary btn-sm" onclick="addItem()">+ 세부항목</button>
  <button class="btn btn-success btn-sm" onclick="refreshData()" title="세부내역 변경사항 반영">🔄 새로고침</button>
  <button class="btn btn-primary btn-sm" onclick="saveOnly()">✓ 저장</button>
</div>

<div class="proj-info">
  <div class="proj-field">
    <span class="proj-label">Plant</span>
    <input class="proj-input" id="qs-plant" placeholder="Plant 명">
  </div>
  <div class="proj-field">
    <span class="proj-label">Project Name</span>
    <input class="proj-input" id="qs-projname" placeholder="프로젝트명">
  </div>
</div>

<div id="sync-banner">🔄 세부내역이 업데이트되었습니다</div>

<div class="main">
  <table>
    <colgroup>
      <col style="width:72px">
      <col>
      <col style="width:200px">
      <col style="width:52px">
      <col style="width:68px">
      <col style="width:120px">
      <col style="width:130px">
      <col style="width:130px">
      <col style="width:48px">
    </colgroup>
    <thead>
      <tr>
        <th>No.</th><th>품명</th><th>형번/사양</th><th>단위</th>
        <th>수량</th><th>단가</th>
        <th style="background:rgba(37,99,235,.08)">금액</th>
        <th>비고</th><th></th>
      </tr>
    </thead>
    <tbody id="qs-tbody"></tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="6" style="text-align:center;font-size:13px;letter-spacing:.05em;padding:10px 12px;">
          합&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;계
        </td>
        <td class="amt" id="qs-total" style="padding:10px 8px;font-size:13px;">—</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>
  <div style="margin-top:10px; font-size:11px; color:var(--text3)">
    💡 그룹행의 금액은 연결된 세부내역 견적가 합계가 자동 반영됩니다.
    세부내역 변경 후 🔄 새로고침을 누르면 최신 금액이 반영됩니다.
  </div>
</div>

${SC}
const QS_KEY = 'sgintech_quot_sheet_data';
const SAVE_KEY = 'sgintech_quot_sheet_saved';
let rows = [];
let clientIdx = 0;

// ── 데이터 로드 ──────────────────────────────────────────
function loadData(merge = false) {
  try {
    const raw = localStorage.getItem(QS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    document.getElementById('qs-plant').value    = data.plant    || '';
    document.getElementById('qs-projname').value = data.projname || '';

    if (merge && rows.length > 0) {
      // 기존 입력값 보존하면서 금액(amt)만 업데이트
      const incoming = data.rows || [];
      rows.forEach((r, i) => {
        const match = incoming.find(ir => ir.id === r.id);
        if (match) r.amt = match.amt;
      });
    } else {
      rows = (data.rows || []).map(r => ({...r}));
      clientIdx = rows.reduce((max, r) => {
        const n = parseInt(r.id.replace(/\\D/g,'')) || 0;
        return Math.max(max, n + 1);
      }, 0);
    }
  } catch(e) {}
}

function saveData() {
  try {
    const plant    = document.getElementById('qs-plant')?.value    || '';
    const projname = document.getElementById('qs-projname')?.value || '';
    localStorage.setItem(SAVE_KEY, JSON.stringify({ rows, plant, projname }));
  } catch(e) {}
}

// 부모창에 현재 rows 실시간 전송 (드롭다운 즉시 갱신)
function notifyParent() {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'QS_ROWS_UPDATED', rows: rows }, '*');
  }
}

// ── 새로고침 (세부내역 변경사항 반영) ───────────────────
function refreshData() {
  loadData(true);  // merge 모드
  renderRows();
  showSyncBanner('🔄 새로고침 완료 — 세부내역 금액이 반영되었습니다');
}

function showSyncBanner(msg) {
  const el = document.getElementById('sync-banner');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// postMessage로 부모창 업데이트 수신
window.addEventListener('message', e => {
  if (e.data?.type === 'QS_UPDATE') {
    loadData(true);
    renderRows();
    showSyncBanner('🔄 세부내역이 변경되었습니다 — 자동 반영됨');
  }
});

// ── 저장 (닫지 않음) ─────────────────────────────────────
function saveOnly() {
  saveData();
  notifyParent();
  // 부모창에 저장 알림 (닫지 않음)
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'QS_SAVED', key: SAVE_KEY }, '*');
  }
  // 저장 완료 배너 표시
  showSyncBanner('✅ 저장되었습니다');
}

// ── 저장 & 닫기 (내부용, 직접 호출 시) ──────────────────
function saveAndClose() {
  saveData();
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'QS_SAVED', key: SAVE_KEY }, '*');
  }
  window.close();
}

// ── 행 렌더링 ─────────────────────────────────────────────
function renderRows() {
  const tbody = document.getElementById('qs-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.id = 'qsr-' + row.id;
    if (row.type === 'group') tr.className = 'group-row';
    tr.innerHTML = buildRowHtml(row, i);
    tbody.appendChild(tr);
  });
  calcTotal();
}

function buildRowHtml(row, i) {
  const amt = row.amt > 0
    ? row.amt.toLocaleString('ko-KR', {maximumFractionDigits:0}) : '—';
  const unitPrice = (row.qty > 0 && row.amt > 0)
    ? Math.round(row.amt / row.qty).toLocaleString('ko-KR') : '—';

  if (row.type === 'group') {
    return \`
      <td><input class="ct-input" value="\${esc(row.no)}" placeholder="No."
                 oninput="rows[\${i}].no=this.value; saveData(); notifyParent()" style="width:60px;text-align:center;
                 font-family:'JetBrains Mono',monospace;color:var(--accent);font-weight:700"></td>
      <td colspan="5"><input class="ct-input" value="\${esc(row.name)}" placeholder="그룹명"
                 oninput="rows[\${i}].name=this.value" style="font-size:13px;font-weight:600"></td>
      <td class="amt" id="amt-\${row.id}">\${amt}</td>
      <td><input class="ct-input" value="\${esc(row.note)}" placeholder="비고"
                 oninput="rows[\${i}].note=this.value" style="color:var(--text2);font-size:11px"></td>
      <td>\${actionBtns(row.id)}</td>\`;
  } else {
    return \`
      <td class="center"><input class="ct-input" value="\${esc(row.no)}" placeholder="No."
                 oninput="rows[\${i}].no=this.value; notifyParent()" style="width:60px;text-align:center"></td>
      <td><input class="ct-input" value="\${esc(row.name)}" placeholder="품명"
                 oninput="rows[\${i}].name=this.value"></td>
      <td><input class="ct-input" value="\${esc(row.spec)}" placeholder="형번/사양"
                 oninput="rows[\${i}].spec=this.value" style="font-size:11px;color:var(--text2)"></td>
      <td class="center"><input class="ct-input" value="\${esc(row.unit)}" placeholder="EA"
                 oninput="rows[\${i}].unit=this.value" style="width:44px;text-align:center"></td>
      <td><input class="ct-input" type="number" value="\${row.qty||''}" placeholder="0"
                 oninput="rows[\${i}].qty=parseFloat(this.value)||0;calcGroupTotals();calcTotal()"
                 style="width:56px;text-align:right"></td>
      <td class="amt muted" id="up-\${row.id}">\${unitPrice}</td>
      <td class="amt" id="amt-\${row.id}">\${amt}</td>
      <td><input class="ct-input" value="\${esc(row.note)}" placeholder="비고"
                 oninput="rows[\${i}].note=this.value" style="font-size:11px;color:var(--text2)"></td>
      <td>\${actionBtns(row.id)}</td>\`;
  }
}

function esc(v) { return (v||'').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function actionBtns(id) {
  return \`<div style="display:flex;flex-direction:column;gap:2px;align-items:center">
    <button class="line-del-btn" style="font-size:10px" onclick="moveRow('up','\${id}')">▲</button>
    <button class="line-del-btn" style="font-size:10px" onclick="moveRow('dn','\${id}')">▼</button>
    <button class="line-del-btn" onclick="removeRow('\${id}')">✕</button>
  </div>\`;
}

// ── 행 조작 ───────────────────────────────────────────────
function addGroup() {
  const id = 'g' + clientIdx++;
  const lastGroup = [...rows].reverse().find(r => r.type === 'group');
  const no = lastGroup ? String(Number(lastGroup.no) + 1) : '1';
  rows.push({ id, type:'group', no, name:'', spec:'', unit:'', qty:0, amt:0, note:'' });
  renderRows();
  saveData(); notifyParent();
}

function addItem() {
  const id = 'i' + clientIdx++;
  const lastGroup = [...rows].reverse().find(r => r.type === 'group');
  const itemsInGroup = lastGroup
    ? rows.filter(r => r.type==='item' && String(r.no).startsWith(lastGroup.no+'-')).length
    : rows.filter(r => r.type==='item').length;
  const autoNo = lastGroup ? (lastGroup.no + '-' + (itemsInGroup + 1)) : String(itemsInGroup + 1);
  rows.push({ id, type:'item', no:autoNo, name:'', spec:'', unit:'EA', qty:1, amt:0, note:'' });
  renderRows();
  saveData(); notifyParent();
}

function moveRow(dir, rowId) {
  const i = rows.findIndex(r => r.id === rowId);
  if (i < 0) return;
  if (dir === 'up' && i > 0)               [rows[i-1], rows[i]] = [rows[i], rows[i-1]];
  if (dir === 'dn' && i < rows.length - 1) [rows[i], rows[i+1]] = [rows[i+1], rows[i]];
  renderRows();
}

function removeRow(rowId) {
  rows = rows.filter(r => r.id !== rowId);
  renderRows();
  calcGroupTotals();
  calcTotal();
  saveData(); notifyParent();
}

// ── 계산 ──────────────────────────────────────────────────
function calcGroupTotals() {
  rows.forEach((row, i) => {
    if (row.type !== 'group') return;
    let sum = 0;
    for (let j = i+1; j < rows.length; j++) {
      if (rows[j].type === 'group') break;
      sum += rows[j].amt || 0;
    }
    row.amt = sum;
    const el = document.getElementById('amt-' + row.id);
    if (el) el.textContent = sum > 0
      ? sum.toLocaleString('ko-KR', {maximumFractionDigits:0}) : '—';
  });
}

function calcTotal() {
  const hasGroups = rows.some(r => r.type === 'group');
  const total = hasGroups
    ? rows.filter(r => r.type==='group').reduce((s,r) => s+(r.amt||0), 0)
    : rows.reduce((s,r) => s+(r.amt||0), 0);
  const el = document.getElementById('qs-total');
  if (el) el.textContent = total > 0
    ? total.toLocaleString('ko-KR', {maximumFractionDigits:0}) : '—';
}

// ── 초기화 ────────────────────────────────────────────────
// QS_KEY(부모창이 방금 밀어넣은 데이터) 우선 로드
loadData(false);

// QS_KEY에 데이터가 없을 때만 SAVE_KEY(이전 편집본) 사용
if (!rows.length) {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      const sd = JSON.parse(saved);
      if (sd.rows && sd.rows.length) {
        rows = sd.rows;
        document.getElementById('qs-plant').value    = sd.plant    || '';
        document.getElementById('qs-projname').value = sd.projname || '';
        clientIdx = rows.reduce((max, r) => {
          const n = parseInt(r.id.replace(/\\D/g,'')) || 0;
          return Math.max(max, n + 1);
        }, 0);
      }
    }
  } catch(e) {}
}

renderRows();
${SCC}
</body>
</html>`;
}

function closeQuotSheet() {
  if (_qsWindow && !_qsWindow.closed) _qsWindow.close();
  _qsWindow = null;
  updateQuotSheetBadge();
}

function updateQuotSheetBadge() {
  const badge = document.getElementById('quot-sheet-badge');
  const btn   = document.getElementById('quot-sheet-btn');
  if (!badge) return;
  const cnt = _qSheetRows.length;
  badge.textContent = cnt;
  badge.style.display = cnt > 0 ? 'inline' : 'none';
  if (btn) btn.style.borderColor = cnt > 0 ? 'var(--green)' : '';
}

/* ── 행 렌더링 ── */
function renderQsRows() {
  const tbody = document.getElementById('qs-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  _qSheetRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.id = 'qs-row-' + row.id;
    tr.dataset.rowid = row.id;

    if (row.type === 'group') {
      // 그룹 행: 배경색 + 품명 span 6칸
      tr.style.background = 'var(--bg3)';
      tr.innerHTML = `
        <td style="padding:7px 8px; border:1px solid var(--border2);
                   text-align:center; font-weight:700; color:var(--accent);
                   font-family:'JetBrains Mono',monospace; font-size:12px;">
          <input style="background:transparent;border:none;outline:none;color:var(--accent);
                        font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;
                        width:56px;text-align:center;"
                 id="qs-no-${row.id}" value="${row.no||''}" placeholder="No."
                 oninput="_qSheetRows[${i}].no=this.value">
        </td>
        <td colspan="5" style="padding:7px 8px; border:1px solid var(--border2); font-weight:600; font-size:13px;">
          <input style="background:transparent;border:none;outline:none;color:var(--text);
                        font-size:13px;font-weight:600;width:100%;"
                 id="qs-name-${row.id}" value="${row.name||''}" placeholder="그룹명 (예: Shuttle System)"
                 oninput="_qSheetRows[${i}].name=this.value">
        </td>
        <td style="padding:7px 8px; border:1px solid var(--border2);
                   background:rgba(37,99,235,0.08); text-align:right;
                   font-family:'JetBrains Mono',monospace; font-size:12px;
                   font-weight:700; color:var(--accent);" id="qs-amt-${row.id}">
          ${row.amt > 0 ? row.amt.toLocaleString(undefined,{maximumFractionDigits:0}) : '—'}
        </td>
        <td style="padding:7px 8px; border:1px solid var(--border2);">
          <input style="background:transparent;border:none;outline:none;color:var(--text2);
                        font-size:11px;width:100%;"
                 id="qs-note-${row.id}" value="${row.note||''}" placeholder="비고"
                 oninput="_qSheetRows[${i}].note=this.value">
        </td>
        <td style="padding:4px; border:1px solid var(--border2); text-align:center;">
          ${qsActionBtns(row.id)}
        </td>`;
    } else {
      // 세부항목 행
      const unitPrice = (row.qty > 0 && row.amt > 0) ? Math.round(row.amt / row.qty).toLocaleString() : '—';
      tr.innerHTML = `
        <td style="padding:6px 8px; border:1px solid var(--border2);
                   text-align:center; font-size:11px; color:var(--text2);">
          <input style="background:transparent;border:none;outline:none;color:var(--text2);
                        font-size:11px;width:56px;text-align:center;"
                 id="qs-no-${row.id}" value="${row.no||''}" placeholder="No."
                 oninput="_qSheetRows[${i}].no=this.value">
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2);">
          <input style="background:transparent;border:none;outline:none;color:var(--text);
                        font-size:12px;width:100%;"
                 id="qs-name-${row.id}" value="${row.name||''}" placeholder="품명"
                 oninput="_qSheetRows[${i}].name=this.value">
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2);">
          <input style="background:transparent;border:none;outline:none;color:var(--text2);
                        font-size:11px;width:100%;"
                 id="qs-spec-${row.id}" value="${row.spec||''}" placeholder="형번/사양"
                 oninput="_qSheetRows[${i}].spec=this.value">
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2); text-align:center;">
          <input style="background:transparent;border:none;outline:none;color:var(--text);
                        font-size:11px;width:44px;text-align:center;"
                 id="qs-unit-${row.id}" value="${row.unit||''}" placeholder="EA"
                 oninput="_qSheetRows[${i}].unit=this.value">
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2); text-align:right;">
          <input style="background:transparent;border:none;outline:none;color:var(--text);
                        font-size:11px;width:56px;text-align:right;"
                 type="number" id="qs-qty-${row.id}" value="${row.qty||''}" placeholder="0"
                 oninput="_qSheetRows[${i}].qty=parseFloat(this.value)||0; qsCalcRow(${i})">
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2); text-align:right;
                   font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text2);"
            id="qs-unitprice-${row.id}">${unitPrice}</td>
        <td style="padding:6px 8px; border:1px solid var(--border2);
                   background:rgba(37,99,235,0.08); text-align:right;
                   font-family:'JetBrains Mono',monospace; font-size:12px;
                   font-weight:600; color:var(--accent);" id="qs-amt-${row.id}">
          ${row.amt > 0 ? row.amt.toLocaleString(undefined,{maximumFractionDigits:0}) : '—'}
        </td>
        <td style="padding:6px 8px; border:1px solid var(--border2);">
          <input style="background:transparent;border:none;outline:none;color:var(--text2);
                        font-size:11px;width:100%;"
                 id="qs-note-${row.id}" value="${row.note||''}" placeholder="비고"
                 oninput="_qSheetRows[${i}].note=this.value">
        </td>
        <td style="padding:4px; border:1px solid var(--border2); text-align:center;">
          ${qsActionBtns(row.id)}
        </td>`;
    }
    tbody.appendChild(tr);
  });
  qsCalcTotal();
}

function qsActionBtns(rowId) {
  return `<div style="display:flex;flex-direction:column;gap:1px;align-items:center;">
    <button class="line-del-btn" style="font-size:10px;padding:1px 3px"
            onclick="qsMoveRow('up','${rowId}')">▲</button>
    <button class="line-del-btn" style="font-size:10px;padding:1px 3px"
            onclick="qsMoveRow('dn','${rowId}')">▼</button>
    <button class="line-del-btn"
            onclick="qsRemoveRow('${rowId}')">✕</button>
  </div>`;
}

/* ── 행 추가 ── */
function qsAddGroup() {
  const id = 'g' + (_qClientIdx++);
  _qSheetRows.push({ id, type:'group', no:'', name:'', spec:'', unit:'', qty:0, amt:0, note:'' });
  renderQsRows();
}

function qsAddItem(afterGroupId = null) {
  const id = 'i' + (_qClientIdx++);
  // 마지막 그룹 번호 기반으로 세부항목 번호 자동 제안
  const lastGroup = [..._qSheetRows].reverse().find(r => r.type === 'group');
  const autoNo   = lastGroup ? (lastGroup.no + '-' + (
    _qSheetRows.filter(r => r.type==='item' && String(r.no).startsWith(lastGroup.no+'-')).length + 1
  )) : '';
  _qSheetRows.push({ id, type:'item', no:autoNo, name:'', spec:'', unit:'EA', qty:1, amt:0, note:'' });
  renderQsRows();
}

/* ── 행 조작 ── */
function qsMoveRow(dir, rowId) {
  const i = _qSheetRows.findIndex(r => r.id === rowId);
  if (i < 0) return;
  if (dir === 'up'  && i > 0)                        { [_qSheetRows[i-1], _qSheetRows[i]] = [_qSheetRows[i], _qSheetRows[i-1]]; }
  if (dir === 'dn'  && i < _qSheetRows.length - 1)  { [_qSheetRows[i],   _qSheetRows[i+1]] = [_qSheetRows[i+1], _qSheetRows[i]]; }
  renderQsRows();
  syncQsFromLinks();
}

function qsRemoveRow(rowId) {
  _qSheetRows = _qSheetRows.filter(r => r.id !== rowId);
  // 연결 규칙에서도 제거
  _qLinkRules = _qLinkRules.filter(r => r.clientRowId !== rowId);
  renderQsRows();
  renderLinkRules();
  qsCalcTotal();
}

/* ── 계산 ── */
function qsCalcRow(i) {
  const row = _qSheetRows[i];
  if (!row || row.type !== 'item') return;
  // 세부항목은 직접 금액 입력(연결) 또는 수량만 있는 경우 단가는 역산
  // amt는 applyAllLinkRules()가 채우거나, 직접 입력 없으면 0
  qsUpdateRowDisplay(row.id);
  qsCalcGroupTotals();
  qsCalcTotal();
}

function qsUpdateRowDisplay(rowId) {
  // rowId는 id 또는 no 값일 수 있음
  const row = _qSheetRows.find(r => r.id === rowId || String(r.no) === rowId);
  if (!row) return;
  const amtEl  = document.getElementById('qs-amt-' + rowId);
  const upEl   = document.getElementById('qs-unitprice-' + rowId);
  if (amtEl) {
    amtEl.textContent = row.amt > 0
      ? row.amt.toLocaleString(undefined,{maximumFractionDigits:0}) : '—';
  }
  if (upEl && row.type === 'item') {
    const up = (row.qty > 0 && row.amt > 0) ? Math.round(row.amt / row.qty).toLocaleString() : '—';
    upEl.textContent = up;
  }
}

// 그룹 합계 = 해당 그룹 이후 다음 그룹 전까지 세부항목 합산
function qsCalcGroupTotals() {
  let currentGroupIdx = -1;
  _qSheetRows.forEach((row, i) => {
    if (row.type === 'group') {
      currentGroupIdx = i;
    } else if (row.type === 'item' && currentGroupIdx >= 0) {
      // 이 item의 그룹 누적은 아래에서 처리
    }
  });
  // 각 그룹별로 소속 item 합산
  _qSheetRows.forEach((row, i) => {
    if (row.type !== 'group') return;
    // 다음 그룹 또는 끝까지의 item들 합산
    let sum = 0;
    for (let j = i+1; j < _qSheetRows.length; j++) {
      if (_qSheetRows[j].type === 'group') break;
      sum += _qSheetRows[j].amt || 0;
    }
    row.amt = sum;
    const el = document.getElementById('qs-amt-' + row.id);
    if (el) el.textContent = sum > 0 ? sum.toLocaleString(undefined,{maximumFractionDigits:0}) : '—';
  });
}

function qsCalcTotal() {
  const total = _qSheetRows
    .filter(r => r.type === 'group')
    .reduce((s, r) => s + (r.amt || 0), 0);
  // 그룹 없으면 item 합산
  const total2 = _qSheetRows.every(r => r.type !== 'group')
    ? _qSheetRows.reduce((s, r) => s + (r.amt || 0), 0) : total;
  const el = document.getElementById('qs-total');
  if (el) el.textContent = total2 > 0
    ? total2.toLocaleString(undefined,{maximumFractionDigits:0}) : '—';
}

/* ── 연결 규칙에서 견적서 금액 자동 반영 ── */
function applyAllLinkRules() {
  // 1) 모든 sheetRow amt 초기화
  _qSheetRows.forEach(r => { r.amt = 0; });

  // 2) 세부내역 각 행의 linkto(no 값) → sheetRow에 견적가 합산
  const _allQsRows = getQsRows();
  document.querySelectorAll('#detail-rows tr:not(.dt-subtotal)').forEach(tr => {
    const idx    = tr.id.replace('dr-', '');
    const _sel   = document.getElementById(`dr-linkto-${idx}`);
    const noVal  = _sel?.value || _sel?.dataset?.no || '';
    if (!noVal) return;
    const amt = (_rowCache[idx]?.final
      ?? parseFloat((document.getElementById(`dr-final-${idx}`)?.textContent||'').replace(/,/g,'') || '0'));
    // select value = no 값('1-1')으로 sheetRow 찾기
    const row = _allQsRows.find(r => String(r.no) === noVal)
             || _qSheetRows.find(r => String(r.no) === noVal);
    if (row) row.amt = (row.amt || 0) + amt;
  });

  // 3) 각 row 화면 업데이트
  _qSheetRows.forEach(r => qsUpdateRowDisplay(r.id));

  qsCalcGroupTotals();
  qsCalcTotal();
  updateQuotSheetBadge();
  syncQsWindow();  // 새창에도 반영
}

// 팝업 열릴 때 현재 연결 규칙 반영
function syncQsFromLinks() {
  applyAllLinkRules();
}

/* ── 연결 패널: 견적서 행 드롭다운 (팝업 행 기준) ── */
function reindexClientRows() {
  refreshQsNoDropdowns();   // 세부내역 드롭다운 갱신
  updateQuotSheetBadge();
}

function setClientRowAmt(rowId, amt) {
  // 연결 규칙 적용 시 호출 (applyAllLinkRules에서 처리하므로 여기서는 pass)
}

function calcClientTotal() {
  qsCalcGroupTotals();
  qsCalcTotal();
}

function getClientRowSeq(rowId) {
  const idx = _qSheetRows.findIndex(r => r.id === rowId);
  return idx >= 0 ? idx + 1 : null;
}

// ─── 세부내역 행 ─────────────────────────────────────────────
// ─── 세부내역 행 ─────────────────────────────────────────────
let _qDetailIdx = 0;
const DETAIL_LS_KEY = 'sgintech_col_detail-table';

// 견적서No. 드롭다운 옵션 빌드
// '-' 포함된 번호(세부항목)만 표시 (예: 1-1, 1-2, 2-1)
// 고객용 견적서 데이터 읽기
// 우선순위: 1) 부모창 메모리(_qSheetRows) 2) QS_WINDOW_KEY 3) SAVE_KEY
// SAVE_KEY는 새창 rows를 저장하므로 id 체계가 달라 마지막 순위
function getQsRows() {
  // 1) 부모창 메모리 — 가장 신뢰할 수 있는 최신 데이터
  if (_qSheetRows && _qSheetRows.length) return _qSheetRows;
  // 2) QS_WINDOW_KEY — 부모창이 pushQsDataToStorage로 저장한 데이터
  try {
    const d = JSON.parse(localStorage.getItem('sgintech_quot_sheet_data') || 'null');
    if (d && d.rows && d.rows.length) return d.rows;
  } catch(e) {}
  // 3) SAVE_KEY — 새창에서 저장한 데이터 (id 체계가 다를 수 있음)
  try {
    const saved = JSON.parse(localStorage.getItem('sgintech_quot_sheet_saved') || 'null');
    if (saved && saved.rows && saved.rows.length) return saved.rows;
  } catch(e) {}
  return [];
}

// 구글 시트가 '1-1' → 날짜 ISO 문자열로 자동변환한 것을 역변환
// '2025-12-31T15:00:00.000Z' → KST 기준 '1-1' (1월 1일)
function convertSheetDateToNo(val) {
  if (!val || typeof val !== 'string') return val;
  const v = val.trim();
  // ISO 날짜 문자열 패턴 감지
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  try {
    const d   = new Date(v);
    // KST = UTC+9
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const m   = kst.getUTCMonth() +
