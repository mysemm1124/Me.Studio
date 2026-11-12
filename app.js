import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getDocsFromCache, getDocFromCache, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, collectionGroup, query, where, serverTimestamp, writeBatch, increment, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ---------- 기본값 ---------- */
const IMAGE_TAGS = ['강아지상', '고양이상', '여우상', '두부상', '토끼상', '곰상', '사슴상', '늑대상'];
const REASONS = ['이미지', '연기', '목소리', '분위기', '피지컬', '특기'];
const STAGES = { collected: '수집만', rejected: '서류 탈락', meeting: '미팅/오디션', cast: '최종 캐스팅' };
const RATES = { good: '만족', soso: '보통', bad: '불만족' };
const ROLES = { visitor: '방문자', producer: '제작자', owner: '관리자', banned: '이용 제한' };
const FM_ORIGIN = 'https://www.filmmakers.co.kr';

const S = {
  user: null, me: null, profiles: [], works: [], favs: new Set(), privates: {},
  filters: { q: '', gender: '', ageMin: '', ageMax: '', hMin: '', hMax: '', tags: [], by: '', rate: '', work: '', stage: '', favOnly: false, sort: 'default' },
  pendingImport: null, signingUp: false, loaded: false,
};

/* ---------- 유틸 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = () => $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thisYear = new Date().getFullYear();
const age = (y) => (y ? thisYear - y : null);
const num = (v) => { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
const isProducer = () => ['producer', 'owner'].includes(S.me?.role);
const isOwner = () => S.me?.role === 'owner';
const ms = (t) => (t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : 0);
const fmtDate = (t) => { const m = ms(t); if (!m) return ''; const d = new Date(m); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
const work = (id) => S.works.find((w) => w.id === id);
const workTitle = (id) => work(id)?.title || '';
const CROWN = '<span class="crown" title="관리자 추천"><i class="ti ti-crown"></i>추천</span>';
const img = (src, attrs = '') => `<img src="${esc(src)}" referrerpolicy="no-referrer" loading="lazy" ${attrs}>`;
const posOf = (p) => p?.coverPos ? `${p.coverPos.x}% ${p.coverPos.y}%` : '50% 25%';
const coverImg = (p) => img(p.photos[0], `style="object-position:${posOf(p)}"`);
const ytId = (u) => { const m = String(u).match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : null; };
const instaUrl = (v) => (!v ? '' : /^https?:/.test(v) ? v : `https://www.instagram.com/${v.replace(/^@/, '')}`);
function toast(msg) { const t = document.createElement('div'); t.textContent = msg; Object.assign(t.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: '#262624', color: '#fff', padding: '8px 14px', borderRadius: '8px', fontSize: '13px', zIndex: 99 }); document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }

/* ---------- 데이터 ---------- */
async function loadAll(fromCache = false) {
  const gDocs = fromCache ? getDocsFromCache : getDocs;
  const gDoc = fromCache ? getDocFromCache : getDoc;
  const pq = isProducer() ? collection(db, 'profiles') : query(collection(db, 'profiles'), where('hidden', '==', false));
  const [ps, ws, fv] = await Promise.all([gDocs(pq), gDocs(collection(db, 'works')), gDoc(doc(db, 'favorites', S.user.uid)).catch(() => null)]);
  const profiles = ps.docs.map((d) => ({ id: d.id, ...d.data() }));
  const works = ws.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  const privates = {};
  if (isProducer()) {
    const pv = await Promise.allSettled(profiles.map((p) => gDoc(doc(db, 'profiles', p.id, 'private', 'info'))));
    pv.forEach((r, i) => { privates[profiles[i].id] = r.status === 'fulfilled' && r.value.exists() ? r.value.data() : {}; });
  }
  S.profiles = profiles; S.works = works; S.privates = privates;
  S.favs = new Set(fv && fv.exists() ? fv.data().ids || [] : []);
  return profiles.length + works.length;
}
const allTags = () => [...new Set([...IMAGE_TAGS, ...S.profiles.flatMap((p) => p.imageTags || [])])];
const allReasons = () => [...new Set([...REASONS, ...S.profiles.flatMap((p) => (p.works || []).flatMap((w) => w.reasons || []))])];

/* ---------- 인증 ---------- */
onAuthStateChanged(auth, async (u) => {
  S.user = u; S.me = null; S.loaded = false;
  if (S.signingUp) return;
  await boot();
});

async function boot() {
  if (!S.user) { renderNav(); return renderAuth('login'); }
  const snap = await getDoc(doc(db, 'users', S.user.uid));
  if (!snap.exists()) { renderNav(); return renderAuth('onboard'); }
  S.me = snap.data();
  renderNav();
  if (S.me.role === 'banned') { view().innerHTML = '<div class="card narrow">이용이 제한된 계정입니다. 관리자에게 문의해 주세요.</div>'; return; }
  const saved = sessionStorage.getItem('mestudio-import');
  if (saved && !S.pendingImport) { S.pendingImport = JSON.parse(saved); }
  let shown = false;
  try { if (await loadAll(true)) { S.loaded = true; shown = true; startRoute(); } } catch (e) { /* 캐시 없음 */ }
  const slow = setTimeout(() => { if (!shown) view().innerHTML = '<div class="loading">서버 연결이 지연되고 있습니다. 잠시만 기다려 주세요.<br><button onclick="location.reload()" style="margin-top:12px">새로고침</button></div>'; }, 8000);
  try { await loadAll(false); }
  catch (e) {
    clearTimeout(slow);
    if (!shown) view().innerHTML = `<div class="card narrow">데이터를 불러오지 못했습니다.<div class="err">${esc(e.message)}</div><button onclick="location.reload()" style="margin-top:10px">새로고침</button></div>`;
    else toast('최신 데이터를 불러오지 못해 저장된 데이터로 표시 중입니다');
    return;
  }
  clearTimeout(slow);
  S.loaded = true;
  if (!shown) startRoute();
  else if (!/^#\/(new|edit)/.test(location.hash)) route(true);
}
function startRoute() {
  if (S.pendingImport && isProducer() && location.hash !== '#/new') location.hash = '#/new';
  else route();
}

function renderNav() {
  const n = $('#nav');
  if (!S.me) { n.innerHTML = ''; return; }
  n.innerHTML = `
    <a href="#/">목록</a>
    ${isProducer() ? '<a href="#/new"><i class="ti ti-plus"></i> 프로필 등록</a>' : ''}
    <a href="#/me">마이페이지</a>
    <span class="who">${esc(S.me.name)} · ${ROLES[S.me.role] || ''}</span>
    <button id="logout">로그아웃</button>`;
  $('#logout').onclick = () => signOut(auth);
}

function renderAuth(mode) {
  const v = view();
  if (mode === 'login') {
    v.innerHTML = `<div class="card narrow">
      <div class="h1">로그인</div>
      <label class="f">아이디 또는 이메일</label><input id="lid" autocomplete="username">
      <label class="f">비밀번호</label><input id="lpw" type="password" autocomplete="current-password">
      <div class="err" id="err"></div>
      <button class="primary" id="go" style="width:100%;margin-top:6px">로그인</button>
      <button id="google" style="width:100%;margin-top:8px"><i class="ti ti-brand-google"></i> Google로 계속하기</button>
      <div class="inline" style="justify-content:space-between;margin-top:14px">
        <a href="#" id="toSignup" class="hint">회원가입</a><a href="#" id="toReset" class="hint">비밀번호 찾기</a>
      </div></div>`;
    const go = async () => {
      try {
        let id = $('#lid').value.trim();
        if (!id.includes('@')) {
          const u = await getDoc(doc(db, 'usernames', id.toLowerCase()));
          if (!u.exists()) throw new Error('존재하지 않는 아이디입니다.');
          id = u.data().email;
        }
        await signInWithEmailAndPassword(auth, id, $('#lpw').value);
      } catch (e) { $('#err').textContent = e.message.includes('auth/') ? '아이디 또는 비밀번호가 일치하지 않습니다.' : e.message; }
    };
    $('#go').onclick = go;
    $('#lpw').onkeydown = (e) => e.key === 'Enter' && go();
    $('#google').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => { $('#err').textContent = e.message; });
    $('#toSignup').onclick = (e) => { e.preventDefault(); renderAuth('signup'); };
    $('#toReset').onclick = (e) => { e.preventDefault(); renderAuth('reset'); };
    return;
  }
  if (mode === 'reset') {
    v.innerHTML = `<div class="card narrow"><div class="h1">비밀번호 찾기</div>
      <label class="f">가입한 이메일</label><input id="rem">
      <div class="err" id="err"></div>
      <button class="primary" id="go" style="width:100%">재설정 메일 보내기</button>
      <a href="#" id="back" class="hint" style="display:block;margin-top:12px">로그인으로</a></div>`;
    $('#go').onclick = async () => { try { await sendPasswordResetEmail(auth, $('#rem').value.trim()); $('#err').textContent = '재설정 메일을 발송했습니다. 메일함을 확인해 주세요.'; } catch (e) { $('#err').textContent = e.message; } };
    $('#back').onclick = (e) => { e.preventDefault(); renderAuth('login'); };
    return;
  }
  const onboard = mode === 'onboard';
  v.innerHTML = `<div class="card narrow"><div class="h1">${onboard ? '추가 정보 입력' : '회원가입'}</div>
    ${onboard ? '<div class="hint">Google 계정으로 가입되었습니다. 아래 정보를 입력하면 가입이 완료됩니다.</div>' : ''}
    <label class="f">이름</label><input id="sname" value="${esc(onboard ? S.user?.displayName || '' : '')}">
    <label class="f">아이디 (영문 소문자·숫자·_ 3~20자)</label>
    <div class="inline" style="flex-wrap:nowrap"><input id="sid" autocomplete="username" style="flex:1;width:100%"><button id="sidcheck" type="button" style="white-space:nowrap">중복 확인</button></div>
    <div class="hint" id="sidmsg" style="margin-top:4px;min-height:1em"></div>
    ${onboard ? '' : `<label class="f">비밀번호 (6자 이상)</label><input id="spw" type="password" autocomplete="new-password">
    <label class="f">이메일 (비밀번호 찾기용)</label><input id="sem" type="email">`}
    <label class="f">소속 (회사/학교명)</label><input id="saff" placeholder="중앙대학교 영화학과">
    <div class="err" id="err"></div>
    <button class="primary" id="go" style="width:100%">${onboard ? '시작하기' : '가입하기'}</button>
    ${onboard ? '<button id="cancel" style="width:100%;margin-top:8px">다른 계정으로 로그인</button>' : '<a href="#" id="back" class="hint" style="display:block;margin-top:12px">로그인으로</a>'}</div>`;
  if ($('#back')) $('#back').onclick = (e) => { e.preventDefault(); renderAuth('login'); };
  if ($('#cancel')) $('#cancel').onclick = () => signOut(auth);
  let checkedId = null;
  const checkId = async () => {
    const msg = $('#sidmsg'), id = $('#sid').value.trim().toLowerCase();
    checkedId = null; msg.style.color = 'var(--danger)';
    if (!/^[a-z0-9_]{3,20}$/.test(id)) { msg.textContent = '영문 소문자, 숫자, _ 조합 3~20자로 입력해 주세요.'; return false; }
    try {
      if ((await getDoc(doc(db, 'usernames', id))).exists()) { msg.textContent = '이미 사용 중인 아이디입니다.'; return false; }
    } catch (e) { msg.textContent = '확인 중 오류가 발생했습니다.'; return false; }
    checkedId = id; msg.style.color = 'var(--ok)'; msg.textContent = '사용 가능한 아이디입니다.';
    return true;
  };
  $('#sidcheck').onclick = checkId;
  $('#sid').oninput = () => { checkedId = null; $('#sidmsg').textContent = ''; };
  $('#go').onclick = async () => {
    if (checkedId !== $('#sid').value.trim().toLowerCase() && !(await checkId())) { $('#err').textContent = '아이디 중복 확인을 해 주세요.'; return; }
    const err = $('#err');
    const name = $('#sname').value.trim(), uid = $('#sid').value.trim().toLowerCase(), aff = $('#saff').value.trim();
    if (!name || !aff) return (err.textContent = '이름과 소속을 입력해 주세요.');
    if (!/^[a-z0-9_]{3,20}$/.test(uid)) return (err.textContent = '아이디 형식을 확인해 주세요.');
    try {
      if ((await getDoc(doc(db, 'usernames', uid))).exists()) return (err.textContent = '이미 사용 중인 아이디입니다.');
      let user = S.user, email;
      if (onboard) { email = user.email; }
      else {
        email = $('#sem').value.trim();
        if (!email) return (err.textContent = '이메일을 입력해 주세요.');
        S.signingUp = true;
        user = (await createUserWithEmailAndPassword(auth, email, $('#spw').value)).user;
      }
      await setDoc(doc(db, 'users', user.uid), { name, username: uid, email, affiliation: aff, role: 'visitor', createdAt: serverTimestamp() });
      await setDoc(doc(db, 'usernames', uid), { uid: user.uid, email });
      S.signingUp = false; S.user = user;
      await boot();
    } catch (e) { S.signingUp = false; err.textContent = e.message; }
  };
}

/* ---------- 라우터 ---------- */
window.addEventListener('hashchange', () => S.loaded && route());
function route(keepScroll) {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = h.split('/');
  const y = window.scrollY;
  if (!keepScroll) window.scrollTo(0, 0);
  else requestAnimationFrame(() => window.scrollTo(0, y));
  if (a === 'p' && b) return renderDetail(b);
  if (a === 'new') return isProducer() ? renderEdit(null) : renderNoAuth();
  if (a === 'edit' && b) return isProducer() ? renderEdit(b) : renderNoAuth();
  if (a === 'work' && b) return renderWork(b);
  if (a === 'me') return renderMe(b || 'info', c);
  return renderList();
}
const renderNoAuth = () => { view().innerHTML = '<div class="card narrow">제작자 이상만 이용할 수 있는 기능입니다.</div>'; };

/* ---------- 공통 클릭 ---------- */
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { e.preventDefault(); e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button,input,select,textarea,label')) location.hash = go.dataset.go;
});

async function toggleFav(id) {
  const p = S.profiles.find((x) => x.id === id); if (!p) return;
  const on = S.favs.has(id);
  const b = writeBatch(db);
  b.set(doc(db, 'favorites', S.user.uid), { ids: on ? arrayRemove(id) : arrayUnion(id) }, { merge: true });
  b.update(doc(db, 'profiles', id), { favCount: increment(on ? -1 : 1) });
  try { await b.commit(); } catch (e) { return toast('즐겨찾기에 실패했습니다: ' + e.message); }
  on ? S.favs.delete(id) : S.favs.add(id);
  p.favCount = Math.max(0, (p.favCount || 0) + (on ? -1 : 1));
  $$(`[data-fav="${id}"]`).forEach((el) => { el.classList.toggle('on', !on); el.innerHTML = `${!on ? '★' : '☆'} ${p.favCount}`; });
}

/* ---------- 목록 ---------- */
function score(p, q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return 0;
  const wt = (p.works || []).map((w) => workTitle(w.workId)).join(' ').toLowerCase();
  let total = 0;
  for (const t of toks) {
    let s = 0;
    const name = (p.name || '').toLowerCase();
    if (name === t) s += 100; else if (name.includes(t)) s += 50;
    if ((p.imageTags || []).some((x) => x.toLowerCase().includes(t))) s += 20;
    if ((p.specialty || '').toLowerCase().includes(t)) s += 15;
    if (wt.includes(t)) s += 12;
    if ((p.filmo || '').toLowerCase().includes(t) || (p.intro || '').toLowerCase().includes(t)) s += 8;
    if (!s) return -1;
    total += s;
  }
  return total;
}

function filtered() {
  const f = S.filters;
  let list = S.profiles.map((p) => ({ p, s: score(p, f.q) })).filter((x) => x.s >= 0).map(({ p, s }) => ({ ...p, _s: s }));
  list = list.filter((p) => {
    const a = age(p.birthYear);
    if (f.gender && p.gender !== f.gender) return false;
    if (f.ageMin && (a == null || a < +f.ageMin)) return false;
    if (f.ageMax && (a == null || a > +f.ageMax)) return false;
    if (f.hMin && (!p.height || p.height < +f.hMin)) return false;
    if (f.hMax && (!p.height || p.height > +f.hMax)) return false;
    if (f.tags.length && !f.tags.every((t) => (p.imageTags || []).includes(t))) return false;
    if (f.by && p.createdByName !== f.by) return false;
    const r = p.ratingSummary || {};
    if (f.rate === 'good' && !(r.good > 0)) return false;
    if (f.rate === 'nobad' && r.bad > 0) return false;
    if (f.rate === 'rated' && !((r.good || 0) + (r.soso || 0) + (r.bad || 0))) return false;
    if (f.work && !(p.works || []).some((w) => w.workId === f.work)) return false;
    if (f.stage) {
      const st = S.privates[p.id]?.stages || {};
      if (!Object.values(st).includes(f.stage)) return false;
    }
    if (f.favOnly && !S.favs.has(p.id)) return false;
    return true;
  });
  const ko = (a, b) => (a.name || '').localeCompare(b.name || '', 'ko');
  if (f.sort === 'favs') list.sort((a, b) => (b.favCount || 0) - (a.favCount || 0) || ko(a, b));
  else if (f.sort === 'recent') list.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  else list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b._s - a._s || ko(a, b));
  return list;
}

function rowHTML(p) {
  const fav = S.favs.has(p.id);
  const ag = p.birthYear ? `${p.birthYear}년생 (${age(p.birthYear)})` : '';
  const works = [...new Set((p.works || []).map((w) => workTitle(w.workId)).filter(Boolean))];
  const r = p.ratingSummary || {};
  const meta = [p.height && `${p.height}cm`, p.weight && `${p.weight}kg`, p.specialty].filter(Boolean).join(' · ');
  return `<div class="row ${p.featured ? 'feat' : ''}" data-go="#/p/${p.id}">
    <div class="thumb">${p.photos?.[0] ? coverImg(p) : '<i class="ti ti-user"></i>'}</div>
    <div class="row-main">
      <div class="row-top"><span class="nm">${esc(p.name)}</span>${p.featured ? CROWN : ''}${p.hidden ? '<span class="lock-badge"><i class="ti ti-lock"></i>방문자 비공개</span>' : ''}<span class="sub">${esc([p.gender, ag].filter(Boolean).join(' · '))}</span></div>
      ${meta ? `<div class="row-meta">${esc(meta)}</div>` : ''}
      <div>${(p.imageTags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}${works.map((t) => `<span class="chip work">〈${esc(t)}〉</span>`).join('')}</div>
    </div>
    <div class="row-side">
      <button class="star ${fav ? 'on' : ''}" data-fav="${p.id}">${fav ? '★' : '☆'} ${p.favCount || 0}</button>
      ${(r.good || r.soso || r.bad) ? `<div class="mini-rate">만족 ${r.good || 0} · 보통 ${r.soso || 0} · 불만족 ${r.bad || 0}</div>` : ''}
    </div></div>`;
}

function renderList() {
  const f = S.filters;
  const producers = [...new Set(S.profiles.map((p) => p.createdByName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  view().innerHTML = `<div class="layout">
    <aside class="filters card">
      <div class="h2"><i class="ti ti-adjustments"></i>필터</div>
      <label class="f">성별</label>
      <select data-f="gender"><option value="">전체</option><option ${f.gender === '남' ? 'selected' : ''}>남</option><option ${f.gender === '여' ? 'selected' : ''}>여</option></select>
      <label class="f">나이 (만)</label>
      <div class="row2"><input data-f="ageMin" placeholder="최소" value="${esc(f.ageMin)}" inputmode="numeric"><input data-f="ageMax" placeholder="최대" value="${esc(f.ageMax)}" inputmode="numeric"></div>
      <label class="f">키 (cm)</label>
      <div class="row2"><input data-f="hMin" placeholder="최소" value="${esc(f.hMin)}" inputmode="numeric"><input data-f="hMax" placeholder="최대" value="${esc(f.hMax)}" inputmode="numeric"></div>
      <label class="f">이미지</label>
      <div>${allTags().map((t) => `<span class="chip pick ${f.tags.includes(t) ? 'sel' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
      <label class="f">등록한 제작자</label>
      <select data-f="by"><option value="">전체</option>${producers.map((x) => `<option ${f.by === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <label class="f">만족도</label>
      <select data-f="rate"><option value="">전체</option><option value="good" ${f.rate === 'good' ? 'selected' : ''}>만족 1개 이상</option><option value="nobad" ${f.rate === 'nobad' ? 'selected' : ''}>불만족 없음</option><option value="rated" ${f.rate === 'rated' ? 'selected' : ''}>같이 작업해본 배우</option></select>
      <label class="f">지원 및 수집 작품</label>
      <select data-f="work"><option value="">전체</option>${S.works.map((w) => `<option value="${w.id}" ${f.work === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select>
      ${isProducer() ? `<label class="f">진행 단계</label><select data-f="stage"><option value="">전체</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${f.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      <label class="inline" style="margin-top:12px;font-size:13px"><input type="checkbox" data-f="favOnly" ${f.favOnly ? 'checked' : ''} style="width:auto"> 내 즐겨찾기만</label>
      <button id="reset" style="width:100%;margin-top:12px">필터 초기화</button>
    </aside>
    <section>
      <div class="listhead">
        <input data-f="q" placeholder="이름, 특기, 작품, 이미지로 검색" value="${esc(f.q)}">
        <select data-f="sort"><option value="default">추천·연관도순</option><option value="favs" ${f.sort === 'favs' ? 'selected' : ''}>즐겨찾기 많은 순</option><option value="recent" ${f.sort === 'recent' ? 'selected' : ''}>최근 등록순</option></select>
      </div>
      <div id="results"></div>
    </section></div>`;
  const draw = () => {
    const list = filtered();
    $('#results').innerHTML = `<div class="count">${list.length}명</div>` + (list.length ? list.map(rowHTML).join('') : `<div class="empty">${S.profiles.length ? '조건에 맞는 배우가 없습니다.' : '등록된 프로필이 없습니다.'}</div>`);
  };
  $$('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    const ev = el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'input' : 'change';
    el.addEventListener(ev, () => { f[k] = el.type === 'checkbox' ? el.checked : el.value; draw(); });
  });
  $$('[data-tag]').forEach((el) => el.onclick = () => {
    const t = el.dataset.tag; f.tags = f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t];
    el.classList.toggle('sel'); draw();
  });
  $('#reset').onclick = () => { S.filters = { q: '', gender: '', ageMin: '', ageMax: '', hMin: '', hMax: '', tags: [], by: '', rate: '', work: '', stage: '', favOnly: false, sort: 'default' }; renderList(); };
  draw();
}

/* ---------- 상세 ---------- */
async function renderDetail(id) {
  const p = S.profiles.find((x) => x.id === id);
  if (!p) { view().innerHTML = '<div class="card narrow">프로필을 찾을 수 없습니다.</div>'; return; }
  const pv = S.privates[id] || {};
  const fav = S.favs.has(id);
  const photos = p.photos || [];
  const links = [
    p.fmUrl && `<a href="${esc(p.fmUrl)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i>필름메이커스</a>`,
    p.insta && `<a href="${esc(instaUrl(p.insta))}" target="_blank" rel="noopener"><i class="ti ti-brand-instagram"></i>인스타</a>`,
    p.youtube && `<a href="${esc(p.youtube)}" target="_blank" rel="noopener"><i class="ti ti-brand-youtube"></i>유튜브</a>`,
    ...(p.files || []).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener"><i class="ti ti-file-type-pdf"></i>프로필 파일${(p.files.length > 1) ? ' ' + (i + 1) : ''}</a>`),
  ].filter(Boolean).join('');
  const workCards = (p.works || []).map((w) => {
    const wk = work(w.workId); if (!wk) return '';
    const role = (wk.roles || []).find((r) => r.id === w.roleId);
    const stage = isProducer() ? STAGES[pv.stages?.[w.workId]] : '';
    const tip = [role ? `배역: ${role.name}${role.desc ? ' — ' + role.desc : ''}` : '', stage ? `진행: ${stage}` : ''].filter(Boolean).map(esc).join('<br>');
    return `<div class="wcard" data-go="#/work/${wk.id}">
      <div class="wc-top"><b>〈${esc(wk.title)}〉</b>${w.type === '지원' ? '<span class="pill-a">지원</span>' : '<span class="pill-s">직접 선택</span>'}${role ? `<span class="sub">${esc(role.name)}</span>` : ''}${stage ? `<span class="lock-badge">${esc(stage)}</span>` : ''}<span class="sub" style="margin-left:auto">${esc(w.byName || '')}</span></div>
      ${(w.reasons || []).length ? `<div style="margin-top:4px"><span class="sub">매력 포인트</span> ${w.reasons.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>` : ''}
      ${tip ? `<div class="tip">${tip}</div>` : ''}</div>`;
  }).join('');
  const vids = (p.videos || []).map((u) => { const y = ytId(u); return `<a href="${esc(u)}" target="_blank" rel="noopener">${y ? img(`https://img.youtube.com/vi/${y}/mqdefault.jpg`) : ''}<span><i class="ti ti-player-play"></i></span></a>`; }).join('');

  view().innerHTML = `
    <div class="dtop">
      <div>
        <div class="mainphoto" id="mainphoto">${photos[0] ? coverImg(p) : '<i class="ti ti-user"></i>'}</div>
        ${isProducer() && photos[0] ? `<div class="phctl"><button id="setCover" class="ghost" style="display:none"><i class="ti ti-photo-check"></i> 대표 사진으로 지정</button><button id="adjCover" class="ghost"><i class="ti ti-arrows-move"></i> 대표 사진 위치 조정</button></div>
        <div id="adjPanel" class="card" style="display:none;margin-top:6px;padding:10px 12px">
          <label class="f" style="margin-top:0">가로 위치</label><input type="range" id="posX" min="0" max="100" step="1" value="${p.coverPos?.x ?? 50}" style="padding:0">
          <label class="f">세로 위치</label><input type="range" id="posY" min="0" max="100" step="1" value="${p.coverPos?.y ?? 25}" style="padding:0">
          <div class="inline" style="margin-top:8px;justify-content:flex-end"><button id="posCancel">취소</button><button class="primary" id="posSave">저장</button></div></div>` : ''}
        ${photos.length > 1 ? `<div class="thumbs">${photos.map((u, i) => img(u, `data-i="${i}" class="${i === 0 ? 'on' : ''} ${i >= 10 ? 'more' : ''}"`)).join('')}</div>
        ${photos.length > 10 ? `<button id="morePh" class="ghost" style="width:100%;margin-top:6px;font-size:13px;color:var(--sub)">사진 ${photos.length - 10}장 더보기</button>` : ''}` : ''}
      </div>
      <div>
        <div class="dname">
          <span class="n">${esc(p.name)}</span>${p.featured ? CROWN : ''}
          <span class="sub">${esc([p.gender, p.birthYear && `${p.birthYear}년생 (만 ${age(p.birthYear)})`].filter(Boolean).join(' · '))}</span>
          ${p.hidden ? '<span class="lock-badge"><i class="ti ti-lock"></i>방문자 비공개</span>' : ''}
          <span style="margin-left:auto" class="inline">
            <button class="star ${fav ? 'on' : ''}" data-fav="${p.id}">${fav ? '★' : '☆'} ${p.favCount || 0}</button>
            ${isOwner() ? `<button id="featBtn" class="ghost" title="추천 뱃지">${p.featured ? '추천 해제' : '<i class="ti ti-crown" style="color:var(--crown)"></i> 추천'}</button>` : ''}
            ${isProducer() ? `<a href="#/edit/${p.id}"><button>수정</button></a>` : ''}
          </span>
        </div>
        <div style="margin-top:6px">${(p.imageTags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        ${links ? `<div class="linkbtns">${links}</div>` : ''}
        <div class="stats">
          <div class="stat"><div class="l">키</div><div class="v">${p.height ? p.height + 'cm' : '-'}</div></div>
          <div class="stat"><div class="l">체중</div><div class="v">${p.weight ? p.weight + 'kg' : '-'}</div></div>
          <div class="stat wide"><div class="l">특기</div><div class="v">${esc(p.specialty || '-')}</div></div>
        </div>
        <div class="contact"><span class="sub">연락처</span>
          ${isProducer() ? `<span>${esc(pv.phone || '-')}</span><span>${esc(pv.email || '')}</span>` : '<span class="sub">제작자 이상만 열람할 수 있습니다</span>'}
          <span class="lock-badge" style="margin-left:auto"><i class="ti ti-lock"></i>제작자 이상</span></div>
        <div class="meta-line">등록: ${esc(p.createdByName || '')} · ${fmtDate(p.createdAt)}${p.editCount ? ` · 수정 ${p.editCount}회` : ''}</div>
    <div class="sec"><div class="h2"><i class="ti ti-movie"></i>지원 및 수집 경로</div>${workCards || '<div class="hint">연결된 작품이 없습니다.</div>'}</div>
    <div class="grid2">
      <div class="sec" id="rateSec"><div class="h2"><i class="ti ti-mood-smile"></i>작업 만족도</div><div class="hint">불러오는 중…</div></div>
      <div class="sec" id="cmtSec"><div class="h2"><i class="ti ti-message"></i>제작자 코멘트</div><div class="hint">불러오는 중…</div></div>
    </div>
    ${vids ? `<div class="sec"><div class="h2"><i class="ti ti-player-play"></i>출연영상</div><div class="vids">${vids}</div></div>` : ''}
    ${p.filmo ? `<div class="sec"><details><summary>참여작품</summary><div class="filmo">${esc(p.filmo)}</div></details></div>` : ''}
    ${p.intro ? `<div class="sec"><details><summary>프로필 본문</summary><div class="filmo">${esc(p.intro)}</div></details></div>` : ''}
      </div>
    </div>`;

  let cur = 0;
  $$('.thumbs img').forEach((t) => t.onclick = () => {
    cur = +t.dataset.i;
    $('#mainphoto').innerHTML = cur === 0 ? coverImg(p) : img(photos[cur]);
    $$('.thumbs img').forEach((x) => x.classList.remove('on')); t.classList.add('on');
    if ($('#setCover')) { $('#setCover').style.display = cur === 0 ? 'none' : ''; $('#adjCover').style.display = cur === 0 ? '' : 'none'; $('#adjPanel').style.display = 'none'; }
    bindMain();
  });
  if ($('#setCover')) {
    $('#setCover').onclick = async () => {
      const next = [photos[cur], ...photos.filter((_, i) => i !== cur)];
      try { await updateDoc(doc(db, 'profiles', id), { photos: next, coverPos: null }); }
      catch (e) { return toast('변경에 실패했습니다: ' + e.message); }
      p.photos = next; p.coverPos = null; toast('대표 사진이 변경되었습니다'); renderDetail(id);
    };
    const preview = () => { const m = $('#mainphoto img'); if (m) m.style.objectPosition = `${$('#posX').value}% ${$('#posY').value}%`; };
    $('#adjCover').onclick = () => { $('#adjPanel').style.display = $('#adjPanel').style.display === 'none' ? '' : 'none'; };
    $('#posX').oninput = preview; $('#posY').oninput = preview;
    $('#posCancel').onclick = () => { $('#adjPanel').style.display = 'none'; $('#mainphoto img').style.objectPosition = posOf(p); };
    $('#posSave').onclick = async () => {
      const coverPos = { x: +$('#posX').value, y: +$('#posY').value };
      try { await updateDoc(doc(db, 'profiles', id), { coverPos }); }
      catch (e) { return toast('저장에 실패했습니다: ' + e.message); }
      p.coverPos = coverPos; $('#adjPanel').style.display = 'none'; toast('대표 사진 위치가 저장되었습니다');
    };
  }
  if ($('#morePh')) $('#morePh').onclick = () => {
    const open = $('.thumbs').classList.toggle('all');
    $('#morePh').textContent = open ? '사진 접기' : `사진 ${photos.length - 10}장 더보기`;
  };
  const bindMain = () => { const m = $('#mainphoto img'); if (m) m.onclick = () => window.open(m.src, '_blank'); };
  bindMain();
  if ($('#featBtn')) $('#featBtn').onclick = async () => {
    await updateDoc(doc(db, 'profiles', id), { featured: !p.featured });
    p.featured = !p.featured; renderDetail(id);
  };
  loadRatings(p);
  loadComments(p);
}

async function loadRatings(p) {
  const sec = $('#rateSec'); if (!sec) return;
  let snap;
  try { snap = await getDocs(collection(db, 'profiles', p.id, 'ratings')); }
  catch (e) { sec.innerHTML = `<div class="h2"><i class="ti ti-mood-smile"></i>작업 만족도</div><div class="err">평가를 불러오지 못했습니다. ${esc(e.message)}</div>`; return; }
  const rs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const sum = { good: 0, soso: 0, bad: 0 }; rs.forEach((r) => sum[r.value]++);
  const linkedWorks = new Set((p.works || []).map((w) => w.workId));
  const workOrder = [...S.works].sort((a, b) => (linkedWorks.has(b.id) ? 1 : 0) - (linkedWorks.has(a.id) ? 1 : 0));
  sec.innerHTML = `<div class="h2"><i class="ti ti-mood-smile"></i>작업 만족도 <span class="hint" style="font-weight:400">함께 작업한 제작자만</span></div>
    <div class="rsum">${Object.entries(RATES).map(([k, v]) => `<span>${v} ${sum[k]}</span>`).join('')}</div>
    ${rs.map((r) => `<div class="item"><div class="who"><b>${esc(r.name)}</b>${r.workId && work(r.workId) ? `〈${esc(workTitle(r.workId))}〉` : ''}<span class="chip ${r.value === 'good' ? 'sel' : ''}">${RATES[r.value]}</span>
      ${(r.uid === S.user.uid || isOwner()) ? `<span class="acts"><button data-rdel="${r.id}">삭제</button></span>` : ''}</div>
      ${r.comment ? `<div>${esc(r.comment)}</div>` : ''}</div>`).join('') || '<div class="hint">등록된 평가가 없습니다.</div>'}
    ${isProducer() ? `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
      <div class="inline">
        <select id="rwork"><option value="">작품 선택 안 함</option>${workOrder.map((w) => `<option value="${w.id}">${esc(w.title)}</option>`).join('')}</select>
        <div class="seg">${Object.entries(RATES).map(([k, v], i) => `<label><input type="radio" name="rv" value="${k}" ${i === 0 ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
      </div>
      <input id="rcm" placeholder="코멘트 (선택)" style="margin-top:6px">
      <button class="primary" id="rsave" style="margin-top:6px">평가 남기기</button>
      <div class="hint">같은 작품으로 다시 등록하면 기존 평가가 수정됩니다.</div></div>` : ''}`;
  const syncSummary = async () => {
    const all = (await getDocs(collection(db, 'profiles', p.id, 'ratings'))).docs.map((d) => d.data());
    const s = { good: 0, soso: 0, bad: 0 }; all.forEach((r) => s[r.value]++);
    await updateDoc(doc(db, 'profiles', p.id), { ratingSummary: s }); p.ratingSummary = s;
  };
  $$('[data-rdel]', sec).forEach((b) => b.onclick = async () => {
    if (!confirm('이 평가를 삭제하시겠습니까?')) return;
    await deleteDoc(doc(db, 'profiles', p.id, 'ratings', b.dataset.rdel));
    if (isProducer()) await syncSummary(); loadRatings(p);
  });
  if ($('#rsave')) $('#rsave').onclick = async () => {
    const workId = $('#rwork').value;
    await setDoc(doc(db, 'profiles', p.id, 'ratings', `${S.user.uid}_${workId || 'none'}`), {
      uid: S.user.uid, name: S.me.name, workId, value: $('input[name=rv]:checked').value, comment: $('#rcm').value.trim(), createdAt: serverTimestamp(),
    });
    await syncSummary(); loadRatings(p); toast('평가가 등록되었습니다');
  };
}

async function loadComments(p) {
  const sec = $('#cmtSec'); if (!sec) return;
  const ref = collection(db, 'profiles', p.id, 'comments');
  let snap;
  try { snap = await getDocs(isProducer() ? ref : query(ref, where('producerOnly', '==', false))); }
  catch (e) { sec.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const cs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const tops = cs.filter((c) => !c.parentId);
  const one = (c, reply) => `<div class="item ${reply ? 'reply' : ''}">
    <div class="who"><b>${esc(c.name)}</b><span>${esc(c.affiliation || '')}</span><span>${fmtDate(c.createdAt)}</span>${c.producerOnly ? '<span class="lock-badge"><i class="ti ti-lock"></i>제작자만</span>' : ''}
      <span class="acts">${!reply && isProducer() ? `<button data-reply="${c.id}">답글</button>` : ''}${c.uid === S.user.uid ? `<button data-cedit="${c.id}">수정</button>` : ''}${(c.uid === S.user.uid || isOwner()) ? `<button data-cdel="${c.id}">삭제</button>` : ''}</span></div>
    <div style="white-space:pre-wrap">${esc(c.text)}</div></div>`;
  sec.innerHTML = `<div class="h2"><i class="ti ti-message"></i>제작자 코멘트</div>
    ${tops.map((c) => one(c) + cs.filter((r) => r.parentId === c.id).map((r) => one(r, true)).join('')).join('') || '<div class="hint">등록된 코멘트가 없습니다.</div>'}
    ${isProducer() ? `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
      <div id="replyTo" class="hint"></div>
      <textarea id="ctext" placeholder="코멘트 쓰기" style="min-height:60px"></textarea>
      <div class="inline" style="margin-top:6px;justify-content:space-between">
        <label class="inline hint"><input type="checkbox" id="conly" style="width:auto"> 제작자만 보기</label>
        <button class="primary" id="csave">등록</button></div></div>` : ''}`;
  let parentId = null;
  $$('[data-reply]', sec).forEach((b) => b.onclick = () => {
    parentId = b.dataset.reply; const c = cs.find((x) => x.id === parentId);
    $('#replyTo').innerHTML = `${esc(c.name)}님에게 답글 작성 중 · <a href="#" id="noreply">취소</a>`;
    $('#noreply').onclick = (e) => { e.preventDefault(); parentId = null; $('#replyTo').innerHTML = ''; };
    $('#ctext').focus();
  });
  $$('[data-cedit]', sec).forEach((b) => b.onclick = async () => {
    const c = cs.find((x) => x.id === b.dataset.cedit); const t = prompt('코멘트 수정', c.text);
    if (t == null || !t.trim()) return;
    await updateDoc(doc(ref, c.id), { text: t.trim(), editedAt: serverTimestamp() }); loadComments(p);
  });
  $$('[data-cdel]', sec).forEach((b) => b.onclick = async () => {
    if (!confirm('이 코멘트를 삭제하시겠습니까?')) return;
    await deleteDoc(doc(ref, b.dataset.cdel)); loadComments(p);
  });
  if ($('#csave')) $('#csave').onclick = async () => {
    const text = $('#ctext').value.trim(); if (!text) return;
    await addDoc(ref, { uid: S.user.uid, name: S.me.name, affiliation: S.me.affiliation || '', text, producerOnly: $('#conly').checked, parentId, profileId: p.id, profileName: p.name, createdAt: serverTimestamp() });
    loadComments(p);
  };
}

/* ---------- 등록/수정 ---------- */
function renderEdit(id) {
  const editing = id ? S.profiles.find((x) => x.id === id) : null;
  if (id && !editing) { view().innerHTML = '<div class="card narrow">프로필을 찾을 수 없습니다.</div>'; return; }
  const imp = !editing && S.pendingImport ? S.pendingImport : null;
  const p = editing || imp || {};
  const pv = editing ? S.privates[id] || {} : { phone: imp?.phone || '', email: imp?.email || '', stages: {} };
  let tags = [...(p.imageTags || [])];
  let rows = (editing?.works || []).map((w) => ({ ...w, stage: pv.stages?.[w.workId] || '' }));
  const dup = imp?.fmUrl ? S.profiles.find((x) => x.fmUrl === imp.fmUrl) : null;

  view().innerHTML = `
    ${imp ? `<div class="importbar"><b>필름메이커스에서 정보를 불러왔습니다.</b> 내용을 확인한 후 저장해 주세요. <button id="dropImp" class="ghost">불러온 내용 버리기</button>
      ${dup ? `<div style="margin-top:6px">이미 등록된 배우입니다 → <a href="#/p/${dup.id}">${esc(dup.name)} 프로필 보기</a></div>` : ''}</div>` : ''}
    <div class="h1">${editing ? '프로필 수정' : '프로필 등록'}</div>
    <div class="drop" id="drop">
      <i class="ti ti-file-upload" style="font-size:26px"></i>
      <div><b>프로필 파일로 자동 입력</b>
      <div class="hint">PDF, PPTX, 이미지 파일을 끌어다 놓거나 클릭하여 선택해 주세요. 비어 있는 칸만 채워지며, 이미 입력된 내용은 유지됩니다.</div></div>
      <input type="file" id="dropfile" accept=".pdf,.pptx,.jpg,.jpeg,.png,.webp" hidden>
    </div>
    <div id="dropmsg" class="hint" style="margin:-6px 0 12px"></div>
    <div class="card">
      <div class="h2">기본 정보</div>
      <div class="row3">
        <div><label class="f">이름 *</label><input id="e_name" value="${esc(p.name)}"></div>
        <div><label class="f">성별</label><select id="e_gender"><option value="">-</option><option ${p.gender === '남' ? 'selected' : ''}>남</option><option ${p.gender === '여' ? 'selected' : ''}>여</option></select></div>
        <div><label class="f">출생년도</label><input id="e_birth" value="${esc(p.birthYear || '')}" inputmode="numeric" placeholder="1998"></div>
        <div><label class="f">키 (cm)</label><input id="e_height" value="${esc(p.height || '')}" inputmode="numeric"></div>
        <div><label class="f">체중 (kg)</label><input id="e_weight" value="${esc(p.weight || '')}" inputmode="numeric"></div>
        <div><label class="f">특기</label><input id="e_spec" value="${esc(p.specialty)}"></div>
      </div>
      <label class="f">이미지 태그 (클릭해서 선택)</label>
      <div id="tagbox"></div>
      <div class="inline" style="margin-top:6px"><input id="newtag" placeholder="새 태그" style="width:160px"><button id="addtag">추가</button></div>
      <label class="inline" style="margin-top:12px"><input type="checkbox" id="e_hidden" ${p.hidden ? 'checked' : ''} style="width:auto"> 방문자에게 비공개</label>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="h2">연락처 · 링크 <span class="lock-badge"><i class="ti ti-lock"></i>연락처는 제작자 이상만</span></div>
      <div class="row2">
        <div><label class="f">전화번호</label><input id="e_phone" value="${esc(pv.phone)}"></div>
        <div><label class="f">이메일</label><input id="e_email" value="${esc(pv.email)}"></div>
        <div><label class="f">인스타 (주소 또는 아이디)</label><input id="e_insta" value="${esc(p.insta)}"></div>
        <div><label class="f">유튜브 채널</label><input id="e_yt" value="${esc(p.youtube)}"></div>
      </div>
      <label class="f">필름메이커스 주소</label><input id="e_fm" value="${esc(p.fmUrl)}">
      <label class="f">프로필 파일 링크 (한 줄에 하나)</label><textarea id="e_files" style="min-height:50px">${esc((p.files || []).join('\n'))}</textarea>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="h2">사진 · 영상</div>
      <label class="f">사진 주소 (한 줄에 하나, 첫 줄이 대표 사진)</label><textarea id="e_photos">${esc((p.photos || []).join('\n'))}</textarea>
      <div class="prev" id="photoprev"></div>
      <label class="f">출연영상 링크 (한 줄에 하나)</label><textarea id="e_videos" style="min-height:50px">${esc((p.videos || []).join('\n'))}</textarea>
      <label class="f">참여작품</label><textarea id="e_filmo" style="min-height:140px">${esc(p.filmo)}</textarea>
      <label class="f">프로필 본문 (자기소개 등)</label><textarea id="e_intro" style="min-height:100px">${esc(p.intro)}</textarea>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="h2">지원 및 수집 경로</div>
      <div id="wrows"></div>
      <button id="addrow"><i class="ti ti-plus"></i> 작품 연결</button>
    </div>

    <div class="savebar">
      ${editing && (isOwner() || editing.createdBy === S.user.uid) ? '<button class="danger" id="del" style="margin-right:auto">삭제</button>' : ''}
      <button id="cancel">취소</button><button class="primary" id="save">저장</button>
    </div>`;

  const drop = $('#drop'), dropfile = $('#dropfile');
  const handleFile = async (file) => {
    if (!file) return;
    const msg = $('#dropmsg');
    drop.classList.add('busy'); msg.style.color = 'var(--sub)';
    msg.innerHTML = `<i class="ti ti-loader-2 spin"></i> ${esc(file.name)} 분석 중입니다. 10~30초 정도 소요됩니다.`;
    try {
      const r = await analyzeFile(file);
      const map = { name: 'e_name', birthYear: 'e_birth', height: 'e_height', weight: 'e_weight', specialty: 'e_spec', phone: 'e_phone', email: 'e_email', insta: 'e_insta', youtube: 'e_yt', filmo: 'e_filmo', intro: 'e_intro' };
      let n = 0;
      for (const [k, idv] of Object.entries(map)) {
        const v = r[k]; const el = $('#' + idv);
        if (v != null && String(v).trim() && !el.value.trim()) { el.value = String(v).trim(); n++; }
      }
      if ((r.gender === '남' || r.gender === '여') && !$('#e_gender').value) { $('#e_gender').value = r.gender; n++; }
      const vids = Array.isArray(r.videos) ? r.videos.filter(Boolean) : [];
      if (vids.length) { const cur = lines($('#e_videos').value); const add = vids.filter((u) => !cur.includes(u)); if (add.length) { $('#e_videos').value = [...cur, ...add].join('\n'); n++; } }
      msg.style.color = 'var(--ok)';
      msg.textContent = n ? `${n}개 항목이 입력되었습니다. 내용을 확인한 후 저장해 주세요.` : '새로 입력할 항목이 없습니다. (이미 입력되어 있거나 파일에서 찾지 못했습니다)';
    } catch (e) { msg.style.color = 'var(--danger)'; msg.textContent = e.message; }
    finally { drop.classList.remove('busy'); dropfile.value = ''; }
  };
  drop.onclick = () => dropfile.click();
  dropfile.onchange = () => handleFile(dropfile.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); };

  const drawTags = () => {
    const pool = [...new Set([...allTags(), ...tags])];
    $('#tagbox').innerHTML = pool.map((t) => `<span class="chip pick ${tags.includes(t) ? 'sel' : ''}" data-t="${esc(t)}">${esc(t)}</span>`).join('');
    $$('#tagbox [data-t]').forEach((el) => el.onclick = () => { const t = el.dataset.t; tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]; drawTags(); });
  };
  drawTags();
  $('#addtag').onclick = () => { const t = $('#newtag').value.trim(); if (t && !tags.includes(t)) tags.push(t); $('#newtag').value = ''; drawTags(); };
  const drawPrev = () => { $('#photoprev').innerHTML = lines($('#e_photos').value).map((u) => img(u)).join(''); };
  $('#e_photos').oninput = drawPrev; drawPrev();

  const drawRows = () => {
    const box = $('#wrows');
    box.innerHTML = rows.map((r, i) => {
      const wk = work(r.workId);
      return `<div class="wrow" data-i="${i}">
        <div class="inline">
          <select data-k="workId" style="min-width:180px"><option value="">작품 선택</option>${S.works.map((w) => `<option value="${w.id}" ${r.workId === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}<option value="__new">+ 새 작품</option></select>
          <div class="seg"><label><input type="radio" name="t${i}" value="지원" ${r.type === '지원' ? 'checked' : ''}><span>지원</span></label><label><input type="radio" name="t${i}" value="선택" ${r.type === '선택' ? 'checked' : ''}><span>직접 선택</span></label></div>
          <button class="ghost danger" data-rm="${i}" style="margin-left:auto"><i class="ti ti-x"></i></button>
        </div>
        ${r.type === '선택' ? `<div style="margin-top:8px"><span class="hint">매력 포인트 </span>${allReasons().concat((r.reasons || []).filter((x) => !allReasons().includes(x))).map((x) => `<span class="chip pick ${(r.reasons || []).includes(x) ? 'sel' : ''}" data-reason="${esc(x)}">${esc(x)}</span>`).join('')}<span class="chip pick" data-reason="__new">+ 직접 입력</span></div>` : ''}
        <div class="inline" style="margin-top:8px">
          <span class="hint">배역 (선택)</span>
          <select data-k="roleId" ${wk ? '' : 'disabled'}><option value="">-</option>${(wk?.roles || []).map((ro) => `<option value="${ro.id}" ${r.roleId === ro.id ? 'selected' : ''}>${esc(ro.name)}</option>`).join('')}${wk ? '<option value="__new">+ 새 배역</option>' : ''}</select>
          <span class="hint">진행 단계 (선택)</span>
          <select data-k="stage"><option value="">-</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${r.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div></div>`;
    }).join('') || '<div class="hint" style="margin-bottom:8px">연결된 작품이 없습니다. 작품을 연결하면 해당 작품 준비 과정에서 지원·수집한 프로필로 분류됩니다.</div>';
    $$('.wrow', box).forEach((el) => {
      const i = +el.dataset.i, r = rows[i];
      $$('select[data-k]', el).forEach((s) => s.onchange = async () => {
        const k = s.dataset.k;
        if (k === 'workId' && s.value === '__new') {
          const title = prompt('새 작품 제목'); if (!title?.trim()) { drawRows(); return; }
          const ref = await addDoc(collection(db, 'works'), { title: title.trim(), roles: [], createdBy: S.user.uid, createdByName: S.me.name, createdAt: serverTimestamp() });
          S.works.push({ id: ref.id, title: title.trim(), roles: [] }); S.works.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
          r.workId = ref.id; r.roleId = '';
        } else if (k === 'roleId' && s.value === '__new') {
          const wk = work(r.workId); const role = await addRole(wk); r.roleId = role ? role.id : '';
        } else { r[k] = s.value; if (k === 'workId') r.roleId = ''; }
        drawRows();
      });
      $$(`input[name=t${i}]`, el).forEach((rb) => rb.onchange = () => { r.type = rb.value; drawRows(); });
      $$('[data-reason]', el).forEach((c) => c.onclick = () => {
        let x = c.dataset.reason;
        if (x === '__new') { x = prompt('매력 포인트'); if (!x?.trim()) return; x = x.trim(); }
        r.reasons = r.reasons || [];
        r.reasons = r.reasons.includes(x) ? r.reasons.filter((y) => y !== x) : [...r.reasons, x];
        drawRows();
      });
      $(`[data-rm="${i}"]`, el).onclick = () => { rows.splice(i, 1); drawRows(); };
    });
  };
  drawRows();
  $('#addrow').onclick = () => { rows.push({ workId: '', type: '지원', reasons: [], roleId: '', stage: '' }); drawRows(); };
  if ($('#dropImp')) $('#dropImp').onclick = () => { S.pendingImport = null; sessionStorage.removeItem('mestudio-import'); renderEdit(null); };
  $('#cancel').onclick = () => { history.back(); };
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm(`${editing.name} 프로필을 삭제하시겠습니까? 삭제 후에는 복구할 수 없습니다.`)) return;
    await deleteDoc(doc(db, 'profiles', id));
    S.profiles = S.profiles.filter((x) => x.id !== id); location.hash = '#/';
  };
  $('#save').onclick = async () => {
    const name = $('#e_name').value.trim(); if (!name) return toast('이름을 입력해 주세요');
    const valid = rows.filter((r) => r.workId);
    const data = {
      name, gender: $('#e_gender').value, birthYear: num($('#e_birth').value), height: num($('#e_height').value), weight: num($('#e_weight').value),
      specialty: $('#e_spec').value.trim(), imageTags: tags, hidden: $('#e_hidden').checked,
      insta: $('#e_insta').value.trim(), youtube: $('#e_yt').value.trim(), fmUrl: $('#e_fm').value.trim(),
      files: lines($('#e_files').value), photos: lines($('#e_photos').value), videos: lines($('#e_videos').value), filmo: $('#e_filmo').value.trim(), intro: $('#e_intro').value.trim(),
      works: valid.map((r) => ({ workId: r.workId, type: r.type || '지원', reasons: r.type === '선택' ? r.reasons || [] : [], roleId: r.roleId || '', by: r.by || S.user.uid, byName: r.byName || S.me.name })),
      updatedAt: serverTimestamp(),
    };
    const priv = { phone: $('#e_phone').value.trim(), email: $('#e_email').value.trim(), stages: Object.fromEntries(valid.filter((r) => r.stage).map((r) => [r.workId, r.stage])) };
    const btn = $('#save'); btn.disabled = true; btn.textContent = '저장 중…';
    try {
      let pid = id;
      if (editing) {
        await updateDoc(doc(db, 'profiles', id), { ...data, editCount: increment(1) });
        Object.assign(editing, data, { editCount: (editing.editCount || 0) + 1 });
      } else {
        const full = { ...data, featured: false, favCount: 0, ratingSummary: { good: 0, soso: 0, bad: 0 }, editCount: 0, createdBy: S.user.uid, createdByName: S.me.name, createdAt: serverTimestamp() };
        const ref = await addDoc(collection(db, 'profiles'), full); pid = ref.id;
        S.profiles.push({ id: pid, ...full, createdAt: new Date() });
        S.pendingImport = null; sessionStorage.removeItem('mestudio-import');
      }
      await setDoc(doc(db, 'profiles', pid, 'private', 'info'), priv);
      S.privates[pid] = priv;
      location.hash = `#/p/${pid}`;
    } catch (e) { btn.disabled = false; btn.textContent = '저장'; toast('저장에 실패했습니다: ' + e.message); }
  };
}

/* ---------- 프로필 파일 분석 (Gemini) ---------- */
const AI_PROMPT = `다음은 한국 배우의 프로필 자료입니다. 자료에 적힌 정보만 추출하여 JSON 객체 하나로 답하십시오. 자료에 없는 정보는 빈 문자열 "" 또는 null로 두고 절대 추측하지 마십시오.
필드:
- name: 이름
- gender: "남" 또는 "여" (명시되지 않았으면 "")
- birthYear: 출생년도 4자리 숫자 (나이만 적혀 있으면 null)
- height: 키(cm) 숫자
- weight: 체중(kg) 숫자
- specialty: 특기를 쉼표로 구분한 문자열
- phone: 전화번호
- email: 이메일
- insta: 인스타그램 주소 또는 아이디
- youtube: 유튜브 채널 주소 (개별 영상 주소는 제외)
- videos: 개별 출연 영상 주소 배열
- filmo: 출연작·필모그래피 전체. 원문 순서와 분류 제목(영화/드라마/광고 등)을 유지하고 항목마다 줄바꿈
- intro: 자기소개 등 위에 해당하지 않는 소개 문장`;

async function getAI() {
  if (S.ai) return S.ai;
  const d = await getDoc(doc(db, 'config', 'gemini'));
  S.ai = d.exists() ? d.data() : null;
  return S.ai;
}
const toB64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
};
const decodeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function fileToParts(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const imgMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  if (file.size > 18 * 1024 * 1024) throw new Error('파일이 너무 큽니다. 18MB 이하 파일만 분석할 수 있습니다.');
  if (ext === 'pdf') return [{ inline_data: { mime_type: 'application/pdf', data: await toB64(file) } }];
  if (imgMime[ext]) return [{ inline_data: { mime_type: imgMime[ext], data: await toB64(file) } }];
  if (ext === 'pptx') {
    const JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default;
    const zip = await JSZip.loadAsync(file);
    const n = (x) => +x.match(/(\d+)\.xml$/)[1];
    const slides = Object.keys(zip.files).filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a, b) => n(a) - n(b));
    const texts = [];
    for (const [i, name] of slides.entries()) {
      const xml = await zip.file(name).async('string');
      const paras = xml.split('</a:p>').map((pp) => [...pp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('')).filter((t) => t.trim());
      if (paras.length) texts.push(`[슬라이드 ${i + 1}]\n${paras.join('\n')}`);
    }
    const parts = [{ text: texts.join('\n\n') || '(텍스트 없음)' }];
    let total = 0;
    const media = Object.keys(zip.files).filter((x) => /^ppt\/media\/.+\.(png|jpe?g)$/i.test(x)).slice(0, 8);
    for (const m of media) {
      const b64 = await zip.file(m).async('base64');
      if (b64.length > 4e6 || total + b64.length > 1.2e7) continue;
      total += b64.length;
      parts.push({ inline_data: { mime_type: /png$/i.test(m) ? 'image/png' : 'image/jpeg', data: b64 } });
    }
    return parts;
  }
  if (ext === 'ppt') throw new Error('예전 PPT 형식은 지원하지 않습니다. PPTX나 PDF로 저장한 후 다시 올려 주세요.');
  throw new Error('지원하지 않는 파일 형식입니다. PDF, PPTX, 이미지 파일을 올려 주세요.');
}

async function analyzeFile(file) {
  const ai = await getAI();
  if (!ai?.key) throw new Error('Gemini API 키가 등록되지 않았습니다. 관리자가 마이페이지 > AI 설정에서 등록해야 합니다.');
  const parts = await fileToParts(file);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model || 'gemini-flash-latest')}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [...parts, { text: AI_PROMPT }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('분석에 실패했습니다: ' + (j.error?.message || res.status));
  const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').replace(/^```(?:json)?|```$/g, '').trim();
  try { return JSON.parse(text); } catch (e) { throw new Error('분석 결과를 해석하지 못했습니다. 다시 시도해 주세요.'); }
}

async function addRole(wk) {
  const name = prompt(`〈${wk.title}〉 새 배역 이름 (예: 지수 역)`); if (!name?.trim()) return null;
  const desc = prompt('배역 설명 (선택) 예: 20대 학생, 주인공을 짝사랑하는 단짝') || '';
  const role = { id: Math.random().toString(36).slice(2, 10), name: name.trim(), desc: desc.trim() };
  await updateDoc(doc(db, 'works', wk.id), { roles: arrayUnion(role) });
  wk.roles = [...(wk.roles || []), role];
  return role;
}

/* ---------- 작품 페이지 ---------- */
function renderWork(wid) {
  const wk = work(wid);
  if (!wk) { view().innerHTML = '<div class="card narrow">작품을 찾을 수 없습니다.</div>'; return; }
  const linked = S.profiles.filter((p) => (p.works || []).some((w) => w.workId === wid));
  const groups = [...(wk.roles || []), { id: '', name: '배역 미지정', desc: '' }].map((ro) => ({
    ro, ps: linked.filter((p) => (p.works || []).some((w) => w.workId === wid && (w.roleId || '') === ro.id)),
  })).filter((g) => g.ro.id || g.ps.length);
  const mini = (p) => {
    const w = p.works.find((x) => x.workId === wid);
    const st = isProducer() ? STAGES[S.privates[p.id]?.stages?.[wid]] : '';
    return `<div class="row" data-go="#/p/${p.id}"><div class="thumb">${p.photos?.[0] ? coverImg(p) : '<i class="ti ti-user"></i>'}</div>
      <div class="row-main"><div class="row-top"><span class="nm" style="font-size:14px">${esc(p.name)}</span>${p.featured ? CROWN : ''}</div>
      <div>${w.type === '지원' ? '<span class="pill-a">지원</span>' : '<span class="pill-s">직접 선택</span>'} ${st ? `<span class="lock-badge">${esc(st)}</span>` : ''}</div></div></div>`;
  };
  view().innerHTML = `<div class="inline" style="margin-bottom:12px"><span class="h1" style="margin:0">〈${esc(wk.title)}〉</span><span class="sub">${linked.length}명 연결</span>
      ${isProducer() ? '<span style="margin-left:auto" class="inline"><button id="rename">제목 수정</button><button id="newrole"><i class="ti ti-plus"></i> 배역 추가</button></span>' : ''}</div>
    <div class="board">${groups.map((g) => `<div class="col">
      <div class="h2" style="margin-bottom:2px">${esc(g.ro.name)} ${isProducer() && g.ro.id ? `<button class="ghost" data-erole="${g.ro.id}" style="margin-left:auto;padding:0 6px"><i class="ti ti-pencil"></i></button>` : ''}</div>
      ${g.ro.desc ? `<div class="hint" style="margin-bottom:8px">${esc(g.ro.desc)}</div>` : ''}
      ${g.ps.map(mini).join('') || '<div class="hint">없음</div>'}</div>`).join('') || '<div class="hint">등록된 배역과 연결된 프로필이 없습니다.</div>'}</div>`;
  if (!isProducer()) return;
  $('#newrole').onclick = async () => { if (await addRole(wk)) renderWork(wid); };
  $('#rename').onclick = async () => {
    const t = prompt('작품 제목', wk.title); if (!t?.trim()) return;
    await updateDoc(doc(db, 'works', wid), { title: t.trim() }); wk.title = t.trim(); renderWork(wid);
  };
  $$('[data-erole]').forEach((b) => b.onclick = async () => {
    const ro = wk.roles.find((r) => r.id === b.dataset.erole);
    const name = prompt('배역 이름', ro.name); if (name == null) return;
    const desc = prompt('배역 설명', ro.desc || ''); if (desc == null) return;
    const roles = wk.roles.map((r) => (r.id === ro.id ? { ...r, name: name.trim() || r.name, desc: desc.trim() } : r));
    await updateDoc(doc(db, 'works', wid), { roles }); wk.roles = roles; renderWork(wid);
  });
}

/* ---------- 마이페이지 ---------- */
async function renderMe(tab) {
  const tabs = [['info', '내 정보'], ['favs', '즐겨찾기'], ...(isProducer() ? [['mine', '내가 등록한 프로필'], ['comments', '내 댓글'], ['bookmarklet', '필름메이커스 담기 버튼']] : []), ...(isOwner() ? [['members', '회원 관리'], ['ai', 'AI 설정']] : [])];
  if (!tabs.some(([k]) => k === tab)) tab = 'info';
  view().innerHTML = `<div class="tabs">${tabs.map(([k, v]) => `<a href="#/me/${k}" class="${k === tab ? 'on' : ''}">${v}</a>`).join('')}</div><div id="tabbody"></div>`;
  const body = $('#tabbody');
  if (tab === 'info') {
    body.innerHTML = `<div class="card" style="max-width:460px">
      <label class="f">아이디</label><input value="${esc(S.me.username)}" disabled>
      <label class="f">이메일</label><input value="${esc(S.me.email)}" disabled>
      <label class="f">이름</label><input id="m_name" value="${esc(S.me.name)}">
      <label class="f">소속</label><input id="m_aff" value="${esc(S.me.affiliation)}">
      <div class="inline" style="margin-top:12px"><button class="primary" id="msave">저장</button><button id="mpw">비밀번호 재설정 메일</button></div>
      <div class="hint" style="margin-top:8px">권한: ${ROLES[S.me.role]}</div></div>`;
    $('#msave').onclick = async () => {
      const name = $('#m_name').value.trim(), affiliation = $('#m_aff').value.trim();
      if (!name || !affiliation) return toast('이름과 소속을 입력해 주세요');
      await updateDoc(doc(db, 'users', S.user.uid), { name, affiliation }); Object.assign(S.me, { name, affiliation }); renderNav(); toast('저장되었습니다');
    };
    $('#mpw').onclick = async () => { await sendPasswordResetEmail(auth, S.me.email); toast('재설정 메일을 발송했습니다'); };
  } else if (tab === 'favs') {
    const list = S.profiles.filter((p) => S.favs.has(p.id)).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || a.name.localeCompare(b.name, 'ko'));
    body.innerHTML = list.map(rowHTML).join('') || '<div class="empty">즐겨찾기한 배우가 없습니다. 목록에서 ☆를 눌러 추가할 수 있습니다.</div>';
  } else if (tab === 'mine') {
    const list = S.profiles.filter((p) => p.createdBy === S.user.uid).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    body.innerHTML = list.map(rowHTML).join('') || '<div class="empty">등록한 프로필이 없습니다.</div>';
  } else if (tab === 'comments') {
    body.innerHTML = '<div class="loading">불러오는 중…</div>';
    try {
      const snap = await getDocs(query(collectionGroup(db, 'comments'), where('uid', '==', S.user.uid)));
      const cs = snap.docs.map((d) => d.data()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
      body.innerHTML = cs.map((c) => `<div class="item" data-go="#/p/${c.profileId}" style="cursor:pointer"><div class="who"><b>${esc(c.profileName)}</b><span>${fmtDate(c.createdAt)}</span>${c.parentId ? '<span>답글</span>' : ''}${c.producerOnly ? '<span class="lock-badge">제작자만</span>' : ''}</div><div>${esc(c.text)}</div></div>`).join('') || '<div class="empty">작성한 댓글이 없습니다.</div>';
    } catch (e) {
      const link = (e.message.match(/https:\/\/console\.firebase\.google\.com\S+/) || [])[0];
      body.innerHTML = `<div class="card">최초 1회 Firestore 색인 생성이 필요합니다.${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">색인 만들기</a> 후 몇 분 뒤 새로고침해 주세요.` : `<div class="err">${esc(e.message)}</div>`}</div>`;
    }
  } else if (tab === 'bookmarklet') {
    const site = location.origin + location.pathname;
    const code = `javascript:${encodeURIComponent(`(${bookmarklet.toString()})(${JSON.stringify(site)})`)}`;
    body.innerHTML = `<div class="card" style="max-width:640px">
      <div class="h2">필름메이커스 담기 버튼</div>
      <p>아래 버튼을 즐겨찾기 막대로 끌어다 놓으면 설치가 완료됩니다. 필름메이커스 배우 프로필에서 이 버튼을 누르면 정보가 Me.Studio 등록 화면으로 전달됩니다.</p>
      <p><a class="bm" id="bm" href="${esc(code)}">Me.Studio에 담기</a></p>
      <p class="hint">끌어다 놓기가 되지 않는 경우: 아무 페이지나 즐겨찾기에 추가한 뒤, 해당 즐겨찾기를 편집하여 주소 칸에 아래 코드를 전부 붙여넣어 주세요.</p>
      <textarea readonly style="min-height:90px;font-size:11px" id="bmcode">${esc(code)}</textarea>
      <button id="bmcopy" style="margin-top:6px">코드 복사</button>
      <p class="hint">전화번호는 필름메이커스에서 '전화번호 보기'를 먼저 눌러야 함께 저장됩니다. 첨부 PDF는 로그인 상태에서만 링크가 저장됩니다.</p></div>`;
    $('#bm').onclick = (e) => { e.preventDefault(); toast('클릭하지 말고 즐겨찾기 막대로 끌어다 놓아 주세요'); };
    $('#bmcopy').onclick = () => { navigator.clipboard.writeText(code); toast('복사되었습니다'); };
  } else if (tab === 'ai') {
    S.ai = null; const ai = (await getAI().catch(() => null)) || {};
    body.innerHTML = `<div class="card" style="max-width:560px">
      <div class="h2">프로필 파일 자동 입력 (Gemini)</div>
      <p class="hint">PDF·PPTX 프로필을 분석하는 데 사용하는 Google Gemini API 키입니다. 키는 제작자 이상만 읽을 수 있도록 저장됩니다.</p>
      <label class="f">API 키</label><input id="aikey" type="password" value="${esc(ai.key || '')}" placeholder="AIza…">
      <label class="f">모델</label><input id="aimodel" value="${esc(ai.model || 'gemini-flash-latest')}">
      <div class="hint" style="margin-top:4px">기본값 gemini-flash-latest는 최신 Flash 모델을 자동으로 사용합니다.</div>
      <div class="inline" style="margin-top:12px"><button class="primary" id="aisave">저장</button></div>
      <p class="hint" style="margin-top:14px">키 발급: aistudio.google.com 접속 → Get API key → Create API key</p></div>`;
    $('#aisave').onclick = async () => {
      try { await setDoc(doc(db, 'config', 'gemini'), { key: $('#aikey').value.trim(), model: $('#aimodel').value.trim() || 'gemini-flash-latest' }); S.ai = null; toast('저장되었습니다'); }
      catch (e) { toast('저장에 실패했습니다: ' + e.message); }
    };
  } else if (tab === 'members') {
    const snap = await getDocs(collection(db, 'users'));
    const us = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    body.innerHTML = `<div class="card"><table class="t"><tr><th>이름</th><th>아이디</th><th>이메일</th><th>소속</th><th>가입일</th><th>권한</th></tr>
      ${us.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.email)}</td><td>${esc(u.affiliation)}</td><td>${fmtDate(u.createdAt)}</td>
      <td>${u.id === S.user.uid ? ROLES[u.role] : `<select data-uid="${u.id}">${['visitor', 'producer', 'banned'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLES[r]}</option>`).join('')}</select>`}</td></tr>`).join('')}</table>
      <div class="hint" style="margin-top:8px">'이용 제한'으로 변경하면 해당 계정은 사이트를 이용할 수 없습니다.</div></div>`;
    $$('[data-uid]').forEach((s) => s.onchange = async () => { await updateDoc(doc(db, 'users', s.dataset.uid), { role: s.value }); toast('권한이 변경되었습니다'); });
  }
}

/* ---------- 북마클릿에서 넘어온 데이터 받기 ---------- */
window.addEventListener('message', (e) => {
  if (e.origin !== FM_ORIGIN || e.data?.type !== 'mestudio-import') return;
  e.source?.postMessage({ type: 'mestudio-ack' }, e.origin);
  const payload = e.data.payload;
  if (S.pendingImport?.fmUrl === payload.fmUrl) return;
  S.pendingImport = payload;
  sessionStorage.setItem('mestudio-import', JSON.stringify(payload));
  if (!S.loaded) return;
  if (!isProducer()) { toast('프로필 등록은 제작자 이상만 가능합니다'); return; }
  if (location.hash === '#/new') renderEdit(null); else location.hash = '#/new';
});

/* ---------- 북마클릿 본체 (필름메이커스 페이지에서 실행됨) ---------- */
function bookmarklet(SITE) {
  if (!/filmmakers\.co\.kr\/actorProfiles\/\d+/.test(location.href)) { alert('필름메이커스 배우 프로필 페이지에서 눌러 주세요'); return; }
  const main = document.querySelector('main') || document.body;
  const field = (label) => {
    const s = [...main.querySelectorAll('span')].find((x) => x.textContent.trim() === label && !x.closest('select'));
    const row = s?.parentElement?.parentElement;
    return row && row.children[1] ? row.children[1] : null;
  };
  const txt = (el) => (el ? el.innerText.trim() : '');
  const n = (v) => { const m = String(v).match(/\d+/); return m ? +m[0] : null; };
  const body = main.querySelector('.rhymix_content, .xe_content');
  const bodyText = txt(body);
  const gEl = [...main.querySelectorAll('*')].find((e) => e.children.length === 0 && /^(남자|여자)$/.test(e.textContent.trim()) && !e.closest('a,nav,aside,select,option'));
  const phoneRe = /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/;
  const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  let phone = txt(field('전화번호')); if (/보기|확인/.test(phone) || !phoneRe.test(phone)) phone = (bodyText.match(phoneRe) || [''])[0];
  let email = txt(field('이메일')); if (!emailRe.test(email)) email = (bodyText.match(emailRe) || [''])[0];
  const filmoEl = field('참여작품');
  const urls = new Set();
  [field('홈페이지'), filmoEl, body].forEach((el) => el && el.querySelectorAll('a[href]').forEach((a) => { if (!/filmmakers\.co\.kr/.test(a.href)) urls.add(a.href); }));
  ((txt(filmoEl) + '\n' + bodyText).match(/https?:\/\/[^\s<>"')]+/g) || []).forEach((u) => urls.add(u));
  let insta = '', youtube = ''; const videos = [];
  urls.forEach((u) => {
    if (/instagram\.com\/[\w.]+/i.test(u)) { if (!insta) insta = u.split('?')[0]; }
    else if (/youtu\.be\/|youtube\.com\/(watch|shorts|embed)/i.test(u)) { if (!videos.includes(u)) videos.push(u); }
    else if (/youtube\.com\/(channel\/|@|c\/|user\/)/i.test(u)) { if (!youtube) youtube = u.split('?')[0]; }
  });
  if (!insta) { const m = bodyText.match(/(?:insta(?:gram)?|인스타(?:그램)?)\s*[:\-–=]?\s*@?([A-Za-z0-9._]{2,30})/i); if (m && !/^(https?|www)$/i.test(m[1])) insta = 'https://www.instagram.com/' + m[1]; }
  let photos = [];
  const xd = [...main.querySelectorAll('[x-data]')].find((e) => /images\s*:/.test(e.getAttribute('x-data')));
  if (xd) {
    try { photos = (window.Alpine ? window.Alpine.$data(xd).images : null) || []; } catch (e) { photos = []; }
    if (!photos.length) {
      const s = xd.getAttribute('x-data'); const i = s.indexOf('[', s.search(/images\s*:/)); let d = 0, j = i;
      for (; j < s.length; j++) { if (s[j] === '[') d++; else if (s[j] === ']') { d--; if (!d) break; } }
      try { photos = JSON.parse(s.slice(i, j + 1)); } catch (e) { photos = []; }
    }
    photos = photos.filter((p) => !p.isVideo).map((p) => new URL(p.src, location.origin).href);
  }
  const files = [...new Set([...main.querySelectorAll('a[href*="/files/download/"]')].map((a) => a.href))];
  const cert = txt(filmoEl).replace(/\n\s*·\s*\n/g, ' · ').trim();
  const norm = (x) => x.replace(/[\s·.,:;!?~\-–—()<>[\]〈〉《》「」'"‘’“”]/g, '').toLowerCase();
  const fN = norm(cert);
  const intro = bodyText.split('\n').map((l) => l.trim()).filter((l) => { const k = norm(l); return l && !(k.length >= 4 && fN.includes(k)); }).join('\n').trim();
  const data = {
    name: document.title.split(' 배우 프로필')[0].trim(),
    gender: gEl ? (gEl.textContent.trim() === '남자' ? '남' : '여') : '',
    birthYear: n(txt(field('출생년도'))), height: n(txt(field('신장'))), weight: n(txt(field('체중'))),
    specialty: txt(field('특기')), phone, email, insta, youtube, videos, photos, files,
    filmo: cert, intro,
    fmUrl: location.href.split('?')[0].split('#')[0],
  };
  const w = window.open(SITE + '#/new', 'mestudio');
  if (!w) { alert('팝업이 차단되었습니다. 팝업을 허용한 후 다시 눌러 주세요'); return; }
  const origin = new URL(SITE).origin; let tries = 0;
  const t = setInterval(() => { tries++; try { w.postMessage({ type: 'mestudio-import', payload: data }, origin); } catch (e) { /* 로딩 중 */ } if (tries > 120) clearInterval(t); }, 1000);
  window.addEventListener('message', (e) => { if (e.origin === origin && e.data && e.data.type === 'mestudio-ack') clearInterval(t); });
}
