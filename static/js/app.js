'use strict';
/* ==========================================================================
   CareerMatch AI – front-end
   ========================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};

const pageNames = { dashboard: 'Dashboard', analysis: 'New Analysis', results: 'Match Results', chat: 'Career AI Chat', roadmap: 'Learning Roadmap', history: 'Saved Analyses', settings: 'Settings' };
const state = { analysis: null, history: [], period: 'all', trendN: 6, covN: 5, filter: { level: 'all', sort: 'new' }, chatId: null, chats: [], busy: false, aiOn: false, model: '' };
const settings = Object.assign({ name: 'My Workspace', notif: true, save: true }, store.get('cm_settings', {}));

/* ---------- helpers ---------- */
const parseDate = s => new Date(String(s).replace(' ', 'T')).getTime();
const fmtDate = s => { const t = parseDate(s); return isNaN(t) ? esc(s) : new Date(t).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }); };
const shortDate = s => { const t = parseDate(s); return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }); };
function timeAgo(t) {
  if (typeof t === 'string') t = parseDate(t);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (isNaN(s)) return '';
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 172800) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const level = sc => sc >= 80 ? { key: 'strong', label: 'Strong match', cls: 'strong' } : sc >= 60 ? { key: 'potential', label: 'Potential', cls: 'potential' } : { key: 'needs', label: 'Needs work', cls: 'needs-work' };
const logoCls = i => 'logo-' + ['n', 's', 'v', 'k'][i % 4];

async function api(url, opts = {}, timeoutMs = 150000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try { res = await fetch(url, { ...opts, signal: ctrl.signal }); }
  catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The request took too long. Please try again.' : 'Cannot reach the server. Make sure Flask is running (python app.py) and that you opened http://127.0.0.1:5000 in the browser.');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const postJSON = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg) {
  const t = $('#toastMessage');
  t.querySelector('span').textContent = msg;
  t.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = s => String(s || 'file').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'file';

/* ---------- navigation / sidebar ---------- */
const pages = $$('.page-section');
const sidebar = $('#sidebar'), menuToggle = $('#menuToggle'), overlay = $('#mobileOverlay');
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('show'); menuToggle.setAttribute('aria-expanded', 'false'); menuToggle.innerHTML = '<i class="icon icon-menu"></i>'; }
function openSidebar() { closeChatDrawer(); sidebar.classList.add('open'); overlay.classList.add('show'); menuToggle.setAttribute('aria-expanded', 'true'); menuToggle.innerHTML = '<i class="icon icon-x"></i>'; }
function showPage(name) {
  if (!pageNames[name]) name = 'dashboard';
  pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  closeSidebar(); closePop(); closeChatDrawer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  if (name === 'history') loadHistory();
  if (name === 'settings') loadStatus();
  if (name === 'chat') { loadChats(); setTimeout(() => $('#chatInput')?.focus({ preventScroll: true }), 50); }
}
function showTab(tab) {
  $$('.result-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.result-tab-content').forEach(x => x.classList.toggle('active', x.id === 'tab-' + tab));
}
menuToggle.addEventListener('click', () => sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
overlay.addEventListener('click', () => { closeSidebar(); closeChatDrawer(); });
window.addEventListener('resize', () => { if (innerWidth > 767) closeSidebar(); if (innerWidth > 991) closeChatDrawer(); closePop(); });

/* ---------- popover (dropdown menus) ---------- */
const pop = $('#popover');
let popAnchor = null;
function closePop() {
  if (popAnchor) popAnchor.setAttribute('aria-expanded', 'false');
  popAnchor = null; pop.hidden = true; pop.innerHTML = ''; pop._items = null;
}
function placePop() {
  if (!popAnchor) return;
  const r = popAnchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let left = r.right - w;
  left = Math.max(10, Math.min(left, innerWidth - w - 10));
  let top = r.bottom + 8;
  if (top + h > innerHeight - 10) top = Math.max(10, r.top - h - 8);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}
function openPop(anchor, html, cls = '') {
  if (popAnchor === anchor) { closePop(); return; }
  closePop();
  pop.className = 'popover ' + cls; pop.innerHTML = html; pop.hidden = false;
  popAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  placePop();
  pop.querySelector('.menu-item,.notif-item')?.focus?.({ preventScroll: true });
}
function menuHtml(items) {
  return items.map((it, i) => it.sep ? '<div class="menu-sep"></div>' : it.label ? `<div class="menu-label">${esc(it.label)}</div>` :
    `<button class="menu-item${it.active ? ' active' : ''}${it.danger ? ' danger' : ''}" data-mi="${i}">${it.icon ? `<i class="icon icon-${it.icon}"></i>` : ''}<span>${esc(it.text)}</span>${it.active ? '<i class="icon icon-check menu-check"></i>' : ''}</button>`).join('');
}
function showMenu(anchor, items, { cls = '', head = '', foot = '' } = {}) {
  openPop(anchor, head + menuHtml(items) + foot, cls);
  if (popAnchor === anchor) pop._items = items;
}
pop.addEventListener('click', e => {
  const b = e.target.closest('[data-mi]');
  if (!b || !pop._items) return;
  const it = pop._items[+b.dataset.mi];
  closePop();
  it && it.run && it.run();
});
document.addEventListener('click', e => {
  if (pop.hidden) return;
  if (pop.contains(e.target) || (popAnchor && popAnchor.contains(e.target))) return;
  closePop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePop(); closeChatDrawer(); } });
window.addEventListener('scroll', () => { if (!pop.hidden) closePop(); }, { passive: true });

/* ---------- modal ---------- */
function modal({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null }) {
  return new Promise(resolve => {
    const m = $('#modal'), body = $('#modalBody'), okB = $('#modalOk'), cancelB = $('#modalCancel');
    $('#modalTitle').textContent = title; $('#modalText').textContent = text;
    body.innerHTML = input ? `<label class="field-label" for="modalInput">${esc(input.label || '')}</label><input class="text-input" id="modalInput" maxlength="${input.max || 80}" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" autocomplete="off">` : '';
    okB.textContent = ok; okB.className = danger ? 'btn-lime btn-danger' : 'btn-lime';
    cancelB.style.display = cancel ? '' : 'none'; cancelB.textContent = cancel || '';
    m.hidden = false;
    const field = $('#modalInput');
    (field || okB).focus(); field && field.select();
    const done = val => { m.hidden = true; okB.onclick = cancelB.onclick = m.onclick = null; document.removeEventListener('keydown', onKey, true); resolve(val); };
    const submit = () => done(input ? field.value.trim() : true);
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); } else if (e.key === 'Enter' && input) { e.preventDefault(); submit(); } };
    okB.onclick = submit; cancelB.onclick = () => done(input ? null : false);
    m.onclick = e => { if (e.target === m) done(input ? null : false); };
    document.addEventListener('keydown', onKey, true);
  });
}
const confirmBox = (title, text, ok = 'Delete') => modal({ title, text, ok, danger: true });

/* ---------- settings / workspace ---------- */
function initials(n) { const w = n.trim().split(/\s+/).filter(Boolean); return ((w.length > 1 ? w[0][0] + w[1][0] : (w[0] || 'CM').slice(0, 2))).toUpperCase(); }
function applyWorkspace() {
  $('#workspaceName').textContent = settings.name; $('#avatarText').textContent = initials(settings.name);
  const inp = $('#workspaceInput'); if (inp && inp !== document.activeElement) inp.value = settings.name;
}
const saveSettings = () => store.set('cm_settings', settings);
$('#workspaceInput').addEventListener('input', e => { settings.name = e.target.value.trim().slice(0, 24) || 'My Workspace'; applyWorkspace(); saveSettings(); });
$('#workspaceInput').addEventListener('blur', applyWorkspace);
$('#setNotif').checked = settings.notif; $('#setSave').checked = settings.save;
$('#setNotif').addEventListener('change', e => { settings.notif = e.target.checked; saveSettings(); toast(settings.notif ? 'Notifications on' : 'Notifications off'); });
$('#setSave').addEventListener('change', e => { settings.save = e.target.checked; saveSettings(); toast(settings.save ? 'New analyses will be saved' : 'New analyses will NOT be saved'); });
applyWorkspace();

/* ---------- notifications ---------- */
let notifs = store.get('cm_notifs', null) || [{ id: uid(), title: 'Welcome to CareerMatch', text: 'Run your first analysis to get a match score, skill gaps and a learning plan.', time: Date.now(), read: false, page: 'analysis', icon: 'sparkles' }];
const saveNotifs = () => { store.set('cm_notifs', notifs); updateNotifDot(); };
function updateNotifDot() { $('#notifDot').hidden = !notifs.some(n => !n.read); }
function notify(title, text, page, icon = 'check') {
  if (!settings.notif) return;
  notifs.unshift({ id: uid(), title, text, time: Date.now(), read: false, page, icon });
  notifs = notifs.slice(0, 30); saveNotifs();
}
function notifHtml() {
  const unread = notifs.filter(n => !n.read).length;
  const list = notifs.length ? notifs.map(n => `<button class="notif-item${n.read ? '' : ' unread'}" data-nid="${n.id}"><span class="notif-ico"><i class="icon icon-${esc(n.icon || 'bell')}"></i></span><span><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${timeAgo(n.time)}</small></span></button>`).join('')
    : '<div class="notif-empty"><i class="icon icon-bell"></i>You\'re all caught up.</div>';
  return `<div class="pop-head"><strong>Notifications${unread ? ` · ${unread}` : ''}</strong><button data-act="readall" ${unread ? '' : 'disabled'}>Mark all as read</button></div><div class="notif-list">${list}</div>${notifs.length ? '<div class="pop-foot"><button data-act="clearnotifs">Clear all</button></div>' : ''}`;
}
$('#notifBtn').addEventListener('click', () => openPop($('#notifBtn'), notifHtml(), 'pop-notif'));
pop.addEventListener('click', e => {
  const item = e.target.closest('[data-nid]');
  if (item) { const n = notifs.find(x => x.id === item.dataset.nid); if (n) { n.read = true; saveNotifs(); closePop(); if (n.page) showPage(n.page); } return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'readall') { notifs.forEach(n => n.read = true); saveNotifs(); pop.innerHTML = notifHtml(); placePop(); }
  if (act === 'clearnotifs') { notifs = []; saveNotifs(); pop.innerHTML = notifHtml(); placePop(); }
});
updateNotifDot();

/* ---------- workspace (profile) menu ---------- */
$('#profileBtn').addEventListener('click', () => {
  const head = `<div class="profile-top"><span class="avatar">${esc(initials(settings.name))}</span><div><strong>${esc(settings.name)}</strong><small>${state.history.length} saved ${state.history.length === 1 ? 'analysis' : 'analyses'}</small></div></div><div class="menu-sep"></div>`;
  showMenu($('#profileBtn'), [
    { text: 'Dashboard', icon: 'layout-dashboard', run: () => showPage('dashboard') },
    { text: 'Saved analyses', icon: 'folder-clock', run: () => showPage('history') },
    { text: 'Career AI chat', icon: 'message-circle', run: () => showPage('chat') },
    { sep: 1 },
    { text: 'Rename workspace', icon: 'pencil', run: async () => { const v = await modal({ title: 'Rename workspace', input: { label: 'Workspace name', value: settings.name, max: 24 }, ok: 'Save' }); if (v) { settings.name = v; saveSettings(); applyWorkspace(); toast('Workspace renamed'); } } },
    { text: 'Workspace settings', icon: 'settings-2', run: () => showPage('settings') },
  ], { cls: 'pop-profile', head, foot: '<div class="menu-sep"></div><div class="pop-foot-note">CareerMatch AI v1.0 · Beta</div>' });
});

/* ---------- file inputs ---------- */
const MAX_MB = 10;
function setupFile(inputId, dropId, browseId, uploadedId, nameId, sizeId, removeId) {
  const input = $('#' + inputId), drop = $('#' + dropId), browse = $('#' + browseId);
  browse.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) display(input.files[0]); });
  function display(f) {
    if (f.size > MAX_MB * 1024 * 1024) { toast(`File must be under ${MAX_MB} MB`); input.value = ''; return; }
    $('#' + nameId).textContent = f.name; $('#' + sizeId).textContent = (f.size / 1024).toFixed(1) + ' KB · Selected';
    $('#' + uploadedId).hidden = false; drop.style.display = 'none';
  }
  $('#' + removeId).addEventListener('click', () => { input.value = ''; $('#' + uploadedId).hidden = true; drop.style.display = 'flex'; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) { input.files = e.dataTransfer.files; display(f); } });
}
setupFile('resumeFile', 'resumeDrop', 'resumeBrowse', 'resumeUploaded', 'resumeName', 'resumeSize', 'resumeRemove');
const jobFile = $('#jobFile'), jobFileName = $('#jobFileName');
$('#jobBrowse').addEventListener('click', () => jobFile.click());
jobFile.addEventListener('change', () => {
  const f = jobFile.files[0];
  if (!f) { jobFileName.innerHTML = ''; return; }
  if (f.size > MAX_MB * 1024 * 1024) { toast(`File must be under ${MAX_MB} MB`); jobFile.value = ''; return; }
  jobFileName.innerHTML = `${esc(f.name)} <button type="button" class="inline-link" id="jobFileClear" aria-label="Remove job file">✕</button>`;
});
jobFileName.addEventListener('click', e => { if (e.target.id === 'jobFileClear') { jobFile.value = ''; jobFileName.innerHTML = ''; } });
const resumeText = $('#resumeText'), jobText = $('#jobText');
const countText = () => { $('#resumeCount').textContent = resumeText.value.length + ' characters'; $('#jobCount').textContent = jobText.value.length + ' characters'; };
resumeText.addEventListener('input', countText); jobText.addEventListener('input', countText);
$('#sampleBtn').addEventListener('click', () => {
  resumeText.value = 'Frontend developer learner with hands-on projects using HTML, CSS, JavaScript, React, Bootstrap and Git. Built responsive websites, a React weather app, portfolio website and AI-powered web tools. Familiar with REST APIs, UI design, debugging and responsive development.';
  jobText.value = 'Junior Frontend Developer. Requirements: HTML5, CSS3, JavaScript, React, TypeScript basics, responsive design, Git, API integration and testing fundamentals. Build accessible responsive web interfaces, collaborate with designers and maintain clean reusable code.';
  $('#jobTitle').value = 'Junior Frontend Developer'; countText(); toast('Sample resume and job description loaded');
});

/* ---------- analysis ---------- */
async function analyze() {
  const rFile = $('#resumeFile').files[0], jFile = jobFile.files[0];
  if (!resumeText.value.trim() && !rFile) { toast('Add a resume or paste resume text first'); return; }
  if (!jobText.value.trim() && !jFile) { toast('Add a job description first'); return; }
  const btn = $('#analyzeBtn'), prog = $('#analysisProgress'), bar = $('#progressBar'), msg = $('#progressMessage');
  btn.disabled = true; prog.hidden = false; bar.style.width = '15%'; msg.textContent = 'Uploading and extracting text…';
  const form = new FormData();
  form.append('resume_text', resumeText.value); form.append('job_text', jobText.value);
  form.append('role', $('#jobTitle').value); form.append('company', $('#companyName')?.value || '');
  form.append('save', settings.save ? '1' : '0');
  if (rFile) form.append('resume_file', rFile);
  if (jFile) form.append('job_file', jFile);
  const stages = ['Extracting resume information…', 'Comparing required skills…', 'Calculating semantic relevance…', 'Preparing your report…'];
  let ix = 0;
  const timer = setInterval(() => { bar.style.width = Math.min(88, 20 + ix * 17) + '%'; msg.textContent = stages[Math.min(ix, stages.length - 1)]; $$('.progress-step').forEach((s, i) => s.classList.toggle('active', i <= Math.min(ix, 3))); ix++; }, 800);
  try {
    const data = await api('/api/analyze', { method: 'POST', body: form });
    clearInterval(timer); bar.style.width = '100%'; msg.textContent = 'Analysis ready';
    await new Promise(r => setTimeout(r, 300));
    prog.hidden = true; bar.style.width = '0';
    renderAnalysis(data);
    if (data.id) await loadHistory();
    showPage('results');
    toast(data.ai_enabled ? 'AI analysis completed' : 'Analysis completed using local skill matching');
    notify('Analysis completed', `${data.role} · ${data.score}% match`, 'results', 'chart-no-axes-combined');
  } catch (e) {
    clearInterval(timer); prog.hidden = true; bar.style.width = '0'; toast(e.message);
  } finally { btn.disabled = false; }
}
$('#analyzeBtn').addEventListener('click', analyze);

/* ---------- results ---------- */
const listItems = arr => (arr || []).map(x => `<li>${esc(typeof x === 'object' ? x.skill || x.title || x.question || JSON.stringify(x) : x)}</li>`).join('');
const pillsHtml = (arr, cls) => (arr || []).map(s => `<span class="skill-pill ${cls}">${esc(s)}</span>`).join('') || '<span class="empty-note">None detected</span>';
function renderAnalysis(d) {
  state.analysis = d;
  $('#resultsEmpty').hidden = true; $('#resultsContent').hidden = false;
  const matched = d.matched || [], gaps = d.gaps || [], jobSkills = d.job_skills || [], lc = s => String(s).toLowerCase();
  $('#resultScore').textContent = d.score;
  $('#scoreRing').style.background = `conic-gradient(var(--lime) 0 ${d.score}%, #303a42 ${d.score}% 100%)`;
  $('#scoreLabel').textContent = d.score >= 80 ? 'STRONG MATCH' : d.score >= 60 ? 'GOOD POTENTIAL' : 'SKILL GAPS TO ADDRESS';
  $('#resultRole').textContent = d.role;
  $('#resultCompany').textContent = d.company + ' · ' + (d.ai_enabled ? 'AI-powered analysis' : 'Local skill-based analysis');
  $('#resultSummary').textContent = d.summary || '';
  $('#summaryTags').innerHTML = `<span><i class="icon icon-check-circle"></i> ${matched.length} matched</span><span><i class="icon icon-alert-circle"></i> ${gaps.length} gaps</span><span><i class="icon icon-sparkles"></i> ${(d.suggestions || []).length} suggestions</span>`;
  let note = $('#aiNote');
  if (!note) { note = document.createElement('div'); note.id = 'aiNote'; note.className = 'ai-note'; $('#summaryTags').after(note); }
  note.hidden = !d.ai_warning; note.textContent = d.ai_warning ? `AI note: ${d.ai_warning} Showing local skill-based results.` : '';

  $('#ovSkills').innerHTML = jobSkills.map(s => { const m = matched.some(x => lc(x) === lc(s)); return `<div class="skill-row"><span>${esc(s)}</span><span class="skill-status ${m ? 'matched' : 'missing'}">${m ? 'Matched' : 'Gap'}</span><div class="skill-evidence">${m ? 'Detected in resume' : 'Not detected in resume text'}</div></div>`; }).join('') || '<p class="empty-note">No common skill keywords detected. Try a longer resume / job description.</p>';
  $('#ovStrengths').innerHTML = (d.strengths || []).map(s => `<div class="strength-card"><span class="strength-icon"><i class="icon icon-check"></i></span><div><p style="font-size:11px;color:#b6c0c7;margin:0">${esc(s)}</p></div></div>`).join('') || '<p class="empty-note">Add more detail to your resume to surface strengths.</p>';
  $('#skillPills').innerHTML = [...matched.map(s => `<span class="skill-pill matched">${esc(s)} <i class="icon icon-check"></i></span>`), ...gaps.map(s => `<span class="skill-pill missing">${esc(s)} <i class="icon icon-x"></i></span>`), ...(d.extra || []).map(s => `<span class="skill-pill extra">${esc(s)}</span>`)].join('') || '<span class="empty-note">No skills detected.</span>';
  const details = d.gap_details && d.gap_details.length ? d.gap_details : gaps.map((s, i) => ({ skill: s, priority: i < 2 ? 'high' : 'medium', reason: 'Requested in the job description. Learn it and add evidence through a project before claiming it.' }));
  $('#gapList').innerHTML = details.map(g => { const p = String(g.priority || 'medium').toLowerCase(); return `<div class="gap-item"><span class="gap-priority ${p === 'high' ? 'high' : 'medium'}">${p === 'high' ? 'HIGH' : p === 'low' ? 'LOW' : 'MED'}</span><div><strong>${esc(g.skill)}</strong><p>${esc(g.reason)}</p></div><button class="text-button gap-btn" data-page="roadmap">Roadmap</button></div>`; }).join('') || '<p class="empty-note">Great! No skill keyword gaps were detected.</p>';
  $('#gapExtra').innerHTML = pillsHtml(d.extra, 'extra');
  $('#insightsPanel').innerHTML = `<h3>Resume insights</h3><div class="insight-block"><span class="insight-label good">WHAT'S WORKING</span><ul>${listItems(d.strengths) || '<li>—</li>'}</ul></div><div class="insight-block"><span class="insight-label improve">COULD IMPROVE</span><ul>${listItems(d.suggestions) || '<li>—</li>'}</ul></div><div class="insight-block"><span class="insight-label neutral">EXTRA SKILLS</span><div class="skill-pills">${pillsHtml(d.extra, 'extra')}</div></div>`;
  $('#recoPanel').innerHTML = `<h3>Your action plan</h3>${(d.suggestions || []).map((s, i) => `<div class="recommendation"><span class="recommendation-number">${String(i + 1).padStart(2, '0')}</span><div><strong>Action ${i + 1}</strong><p>${esc(s)}</p><button class="copy-suggestion" data-copy="${esc(s)}">Copy suggestion <i class="icon icon-copy"></i></button></div></div>`).join('') || '<p class="empty-note">No suggestions available.</p>'}`;
  $('#interviewPanel').innerHTML = `<h3>Interview prep</h3><p class="panel-sub">Questions tailored to detected job requirements</p>${(d.interview_questions || []).map(q => `<details class="question-item"><summary>${esc(q.question || q)}</summary><p>${esc(q.answer_hint || 'Use a specific example and explain your approach.')}</p></details>`).join('') || '<p class="empty-note">No questions available.</p>'}`;
  const sem = d.semantic_score ?? d.skill_score;
  $('#scoreBreakdown').innerHTML = `<div class="breakdown-title">Score breakdown</div><div class="breakdown-item"><span>Skill keyword coverage</span><strong>${d.skill_score}%</strong><div class="progress-track"><span style="width:${d.skill_score}%"></span></div></div><div class="breakdown-item"><span>Semantic relevance${d.semantic_score == null ? ' (est.)' : ''}</span><strong>${sem}%</strong><div class="progress-track"><span style="width:${sem}%"></span></div></div><div class="breakdown-item"><span>Matched requirements</span><strong>${matched.length}/${jobSkills.length}</strong><div class="progress-track"><span style="width:${d.skill_score}%"></span></div></div><div class="breakdown-item"><span>Resume skills found</span><strong>${(d.resume_skills || []).length}</strong></div>`;
  showTab('overview');
}
function clearResults() { state.analysis = null; $('#resultsEmpty').hidden = false; $('#resultsContent').hidden = true; }
$$('.result-tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

/* ---------- export report ---------- */
function reportText(d) {
  const L = a => (a && a.length ? a.join(', ') : 'None');
  return `CAREERMATCH AI REPORT\n${'='.repeat(40)}\n\nRole: ${d.role}\nCompany: ${d.company}\nDate: ${d.created || ''}\nMatch score: ${d.score}%\n\nSUMMARY\n${d.summary || ''}\n\nMATCHED SKILLS\n${L(d.matched)}\n\nSKILL GAPS\n${(d.gap_details && d.gap_details.length ? d.gap_details.map(g => `- ${g.skill}: ${g.reason}`).join('\n') : L(d.gaps))}\n\nADDITIONAL SKILLS\n${L(d.extra)}\n\nSTRENGTHS\n${(d.strengths || []).map(s => '- ' + s).join('\n') || 'None'}\n\nSUGGESTIONS\n${(d.suggestions || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || 'None'}\n\nINTERVIEW PREP\n${(d.interview_questions || []).map((q, i) => `${i + 1}. ${q.question || q}${q.answer_hint ? '\n   Hint: ' + q.answer_hint : ''}`).join('\n') || 'None'}\n\nLEARNING ROADMAP\n${(d.roadmap || []).map(w => `Week ${w.week}: ${w.title}\n   ${(w.tasks || []).join('; ')}`).join('\n') || 'None'}\n`;
}
function reportHtml(d) {
  const chips = (a, c) => (a || []).map(s => `<span class="chip ${c}">${esc(s)}</span>`).join(' ') || '<em>None</em>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>CareerMatch-Report-${esc(safeName(d.role))}</title><style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1b2127;margin:32px;line-height:1.55;font-size:13px}h1{font-size:22px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid #d8dee3;padding-bottom:5px;text-transform:uppercase;letter-spacing:.6px}
  .meta{color:#5d6a75;margin-bottom:14px}.score{display:inline-block;background:#b7f34a;color:#162010;font-weight:700;font-size:20px;border-radius:10px;padding:8px 16px}
  .chip{display:inline-block;border-radius:5px;padding:3px 8px;margin:2px;font-size:12px;border:1px solid #ccd3d9}.ok{background:#eaf9cf}.bad{background:#ffe6e6}li{margin:4px 0}.q{margin:8px 0}.hint{color:#5d6a75}
  </style></head><body><h1>CareerMatch AI Report</h1><div class="meta">${esc(d.role)} · ${esc(d.company)} · ${esc(d.created || '')}</div><div class="score">${d.score}% match</div>
  <h2>Summary</h2><p>${esc(d.summary)}</p><h2>Matched skills</h2><p>${chips(d.matched, 'ok')}</p><h2>Skill gaps</h2><p>${chips(d.gaps, 'bad')}</p>
  ${(d.gap_details || []).length ? '<ul>' + d.gap_details.map(g => `<li><strong>${esc(g.skill)}</strong> – ${esc(g.reason)}</li>`).join('') + '</ul>' : ''}
  <h2>Strengths</h2><ul>${listItems(d.strengths)}</ul><h2>Suggestions</h2><ol>${listItems(d.suggestions)}</ol>
  <h2>Interview prep</h2>${(d.interview_questions || []).map(q => `<div class="q"><strong>${esc(q.question || q)}</strong>${q.answer_hint ? `<div class="hint">${esc(q.answer_hint)}</div>` : ''}</div>`).join('')}
  <h2>Learning roadmap</h2>${(d.roadmap || []).map(w => `<div class="q"><strong>Week ${esc(w.week)} – ${esc(w.title)}</strong><div class="hint">${esc((w.tasks || []).join(' · '))}</div></div>`).join('')}
  </body></html>`;
}
function printReport(d) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(reportHtml(d)); f.contentDocument.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { toast('Could not open the print dialog'); } setTimeout(() => f.remove(), 60000); }, 350);
}
$('#downloadReport').addEventListener('click', () => {
  const d = state.analysis;
  if (!d) { toast('Run an analysis first'); return; }
  showMenu($('#downloadReport'), [
    { text: 'Save as PDF (print)', icon: 'printer', run: () => { printReport(d); toast('Choose “Save as PDF” in the print dialog'); } },
    { text: 'Download text (.txt)', icon: 'file-text', run: () => { download(`CareerMatch-Report-${safeName(d.role)}.txt`, reportText(d)); toast('Report downloaded'); } },
    { text: 'Download data (.json)', icon: 'download', run: () => { download(`CareerMatch-Report-${safeName(d.role)}.json`, JSON.stringify(d, null, 2), 'application/json'); toast('Report downloaded'); } },
    { sep: 1 },
    { text: 'Copy summary', icon: 'copy', run: () => copyText(`${d.role} – ${d.score}% match\n${d.summary}\nMatched: ${(d.matched || []).join(', ')}\nGaps: ${(d.gaps || []).join(', ')}`, 'Summary copied') },
  ]);
});
function copyText(txt, msg) {
  const done = () => toast(msg || 'Copied');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  function fallback() { const t = document.createElement('textarea'); t.value = txt; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch { toast('Copy failed'); } t.remove(); }
}

/* ---------- global click delegation ---------- */
document.addEventListener('click', e => {
  const pg = e.target.closest('[data-page]');
  if (pg) { showPage(pg.dataset.page); }
  const tab = e.target.closest('[data-tab]');
  if (tab && tab.classList.contains('panel-link')) showTab(tab.dataset.tab);
  const open = e.target.closest('[data-open-analysis]');
  if (open) openAnalysis(+open.dataset.openAnalysis);
  const del = e.target.closest('[data-del-analysis]');
  if (del) deleteAnalysis(+del.dataset.delAnalysis);
  const copy = e.target.closest('.copy-suggestion');
  if (copy) copyText(copy.dataset.copy || '', 'Suggestion copied');
  const prompt = e.target.closest('.prompt-card');
  if (prompt) sendChat(prompt.textContent.trim());
});

/* ---------- history ---------- */
async function loadHistory() {
  try {
    state.history = await api('/api/history');
    renderHistory(); renderDashboard();
    if (!state.analysis && state.history.length) renderAnalysis(state.history[0].payload);
    if (state.analysis && state.analysis.id && !state.history.some(x => x.id === state.analysis.id)) {
      state.history.length ? renderAnalysis(state.history[0].payload) : clearResults();
    }
  } catch (e) { /* server unreachable: keep current UI */ }
}
async function openAnalysis(id) {
  let item = state.history.find(x => x.id === id);
  try { renderAnalysis(item ? item.payload : await api('/api/history/' + id)); showPage('results'); }
  catch (e) { toast(e.message); }
}
async function deleteAnalysis(id) {
  const item = state.history.find(x => x.id === id);
  if (!await confirmBox('Delete this analysis?', item ? `${item.role} · ${item.company} (${item.score}%) will be removed permanently.` : '')) return;
  try {
    await api('/api/history/' + id, { method: 'DELETE' });
    if (state.analysis && Number(state.analysis.id) === Number(id)) { state.analysis = null; clearResults(); }
    state.history = state.history.filter(x => Number(x.id) !== Number(id));
    renderHistory(); renderDashboard();
    await loadHistory();
    renderHistory(); renderDashboard();
    toast('Analysis deleted');
  } catch (e) { toast(e.message); }
}
function filteredHistory() {
  const q = $('#historySearch').value.trim().toLowerCase();
  let items = state.history.filter(x => (!q || `${x.role} ${x.company}`.toLowerCase().includes(q)) && (state.filter.level === 'all' || level(x.score).key === state.filter.level));
  const s = state.filter.sort;
  items = [...items].sort((a, b) => s === 'old' ? a.id - b.id : s === 'high' ? b.score - a.score || b.id - a.id : s === 'low' ? a.score - b.score || b.id - a.id : b.id - a.id);
  return items;
}
function renderHistory() {
  const list = $('.history-list'), items = filteredHistory(), total = state.history.length;
  list.innerHTML = items.length ? items.map((x, i) => { const lv = level(x.score); return `<div class="history-item"><span class="company-logo ${logoCls(i)}">${esc((x.company || 'C')[0].toUpperCase())}</span><div class="history-role"><strong>${esc(x.role)}</strong><small>${esc(x.company)} · ${fmtDate(x.created)}</small></div><div class="history-score"><strong>${x.score}%</strong><small>${lv.label}</small></div><div class="row-actions"><button class="row-action" data-open-analysis="${x.id}" aria-label="Open analysis" title="Open"><i class="icon icon-arrow-up-right"></i></button><button class="row-action danger" data-del-analysis="${x.id}" aria-label="Delete analysis" title="Delete"><i class="icon icon-trash-2"></i></button></div></div>`; }).join('')
    : `<div class="empty-history">${total ? 'No analyses match your search or filters.' : 'No saved analyses yet. Start your first match.'}</div>`;
  $('.history-count').textContent = items.length === total ? `${total} ${total === 1 ? 'analysis' : 'analyses'}` : `${items.length} of ${total}`;
  const n = (state.filter.level !== 'all') + (state.filter.sort !== 'new');
  const fc = $('#filterCount'); fc.hidden = !n; fc.textContent = n;
}
$('#historySearch').addEventListener('input', renderHistory);
$('#filterBtn').addEventListener('click', () => {
  const f = state.filter, set = (k, v) => () => { state[k === 'level' || k === 'sort' ? 'filter' : k][k] = v; renderHistory(); };
  showMenu($('#filterBtn'), [
    { label: 'MATCH LEVEL' },
    { text: 'All matches', active: f.level === 'all', run: set('level', 'all') },
    { text: 'Strong (80%+)', active: f.level === 'strong', run: set('level', 'strong') },
    { text: 'Potential (60–79%)', active: f.level === 'potential', run: set('level', 'potential') },
    { text: 'Needs work (<60%)', active: f.level === 'needs', run: set('level', 'needs') },
    { sep: 1 }, { label: 'SORT BY' },
    { text: 'Newest first', active: f.sort === 'new', run: set('sort', 'new') },
    { text: 'Oldest first', active: f.sort === 'old', run: set('sort', 'old') },
    { text: 'Highest score', active: f.sort === 'high', run: set('sort', 'high') },
    { text: 'Lowest score', active: f.sort === 'low', run: set('sort', 'low') },
    { sep: 1 },
    { text: 'Reset filters', icon: 'rotate-ccw', run: () => { state.filter = { level: 'all', sort: 'new' }; $('#historySearch').value = ''; renderHistory(); } },
  ]);
});

/* ---------- dashboard ---------- */
const PERIODS = { all: ['All time', null], 7: ['Last 7 days', 7], 30: ['Last 30 days', 30], 90: ['Last 90 days', 90] };
function periodItems() {
  const days = PERIODS[state.period][1];
  if (!days) return state.history;
  const cutoff = Date.now() - days * 864e5;
  return state.history.filter(x => { const t = parseDate(x.created); return isNaN(t) || t >= cutoff; });
}
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${Math.max(0, Math.min(100, c1[1]))} ${c2[0]},${Math.max(0, Math.min(100, c2[1]))} ${p2[0]},${p2[1]}`;
  }
  return d;
}
function renderTrend(items) {
  const pts = [...items].sort((a, b) => a.id - b.id).slice(-state.trendN);
  const plot = $('#trendPlot'), xs = $('#trendX');
  $('#trendEmpty').hidden = pts.length > 0;
  if (!pts.length) { plot.innerHTML = ''; xs.innerHTML = ''; return; }
  const n = pts.length, xp = i => n === 1 ? 50 : (i / (n - 1)) * 100;
  const coords = pts.map((p, i) => [xp(i), 100 - p.score]);
  const line = smoothPath(coords);
  plot.className = 'trend-plot';
  plot.innerHTML = `<svg class="trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#b7f34a" stop-opacity=".22"/><stop offset="100%" stop-color="#b7f34a" stop-opacity="0"/></linearGradient></defs>${n > 1 ? `<path d="${line} L100,100 L0,100 Z" fill="url(#areaFill)"/><path d="${line}" fill="none" stroke="#b7f34a" stroke-width="3" vector-effect="non-scaling-stroke"/>` : ''}</svg>` +
    pts.map((p, i) => `<span class="trend-dot" style="left:${xp(i)}%;top:${100 - p.score}%" data-tip="${esc(p.role)} · ${p.score}%"></span>`).join('');
  xs.className = 'chart-x' + (n > 6 ? ' dense' : '');
  xs.innerHTML = pts.map((p, i) => `<span style="left:${xp(i)}%">${shortDate(p.created)}</span>`).join('');
}
function renderCoverage(items) {
  const map = {};
  items.forEach(x => { const p = x.payload || {}, m = new Set((p.matched || []).map(s => s.toLowerCase())); (p.job_skills || []).forEach(s => { const r = map[s] || (map[s] = { n: 0, m: 0 }); r.n++; if (m.has(s.toLowerCase())) r.m++; }); });
  const rows = Object.entries(map).sort((a, b) => b[1].n - a[1].n || b[1].m - a[1].m || a[0].localeCompare(b[0])).slice(0, state.covN);
  $('#skillCoverage').innerHTML = rows.length ? rows.map(([s, r]) => { const pct = Math.round(100 * r.m / r.n); return `<div class="coverage-row"><div><span>${esc(s)}</span><strong>${pct}%</strong></div><div class="progress-track"><span style="width:${pct}%"></span></div><div class="cov-note">Requested in ${r.n} ${r.n === 1 ? 'analysis' : 'analyses'} · found in resume ${r.m}×</div></div>`; }).join('')
    : '<p class="empty-note">No skill data yet. Analyze a job to see which requested skills your resume covers.</p>';
}
function renderDashboard() {
  const items = periodItems(), cards = $$('#page-dashboard .stat-card'), lbl = PERIODS[state.period][0];
  const foot = base => state.period === 'all' ? base : `${lbl} · ${base.toLowerCase()}`;
  const avg = items.length ? Math.round(items.reduce((a, x) => a + x.score, 0) / items.length) : 0;
  const skills = new Set(items.flatMap(x => x.payload?.resume_skills || []));
  cards[0].querySelector('.stat-number').innerHTML = `${items.length} <small class="trend">Saved reports</small>`; cards[0].querySelector('.stat-foot').textContent = foot('Across different roles');
  cards[1].querySelector('.stat-number').innerHTML = `${avg}<span class="stat-percent">%</span>`; cards[1].querySelector('.stat-foot').textContent = foot('Average saved match score');
  cards[2].querySelector('.stat-number').innerHTML = `${skills.size} <small class="trend">Unique skills</small>`; cards[2].querySelector('.stat-foot').textContent = foot('Across your saved resumes');
  if (items.length) { const best = items.reduce((a, b) => a.score >= b.score ? a : b); cards[3].querySelector('.stat-number').innerHTML = `${best.score}<span class="stat-percent">%</span>`; cards[3].querySelector('.stat-foot').textContent = `${best.role} · ${best.company}`; }
  else { cards[3].querySelector('.stat-number').innerHTML = '—'; cards[3].querySelector('.stat-foot').textContent = 'Run an analysis to set your best match'; }
  $('#periodLabel').textContent = lbl;
  $('#trendLabel').textContent = state.trendN >= 100 ? 'All matches' : `Last ${state.trendN} matches`;
  renderTrend(items); renderCoverage(items);
  const table = $('.recent-table'), head = table.querySelector('.recent-head');
  table.innerHTML = ''; table.appendChild(head);
  if (!state.history.length) table.insertAdjacentHTML('beforeend', '<div class="empty-row">No analyses yet. Start your first match.</div>');
  state.history.slice(0, 3).forEach((x, i) => {
    const lv = level(x.score);
    table.insertAdjacentHTML('beforeend', `<div class="recent-row"><div class="role-cell"><span class="company-logo ${logoCls(i)}">${esc((x.company || 'C')[0].toUpperCase())}</span><div><strong>${esc(x.role)}</strong><small>${esc(x.company)}</small></div></div><span class="date-cell">${fmtDate(x.created)}</span><span class="match-cell"><span class="mini-score ${x.score >= 80 ? '' : x.score >= 60 ? 'mid-score' : 'low-score'}">${x.score}%</span></span><span><span class="status-pill ${lv.cls}">${lv.label}</span></span><button class="row-action" data-open-analysis="${x.id}" aria-label="Open analysis"><i class="icon icon-arrow-up-right"></i></button></div>`);
  });
}
$('#periodBtn').addEventListener('click', () => showMenu($('#periodBtn'), Object.entries(PERIODS).map(([k, [t]]) => ({ text: t, active: state.period === k, run: () => { state.period = k; renderDashboard(); } }))));
$('#trendBtn').addEventListener('click', () => showMenu($('#trendBtn'), [[3, 'Last 3 matches'], [6, 'Last 6 matches'], [10, 'Last 10 matches'], [100, 'All matches']].map(([n, t]) => ({ text: t, active: state.trendN === n, run: () => { state.trendN = n; renderDashboard(); } }))));
$('#skillsMenuBtn').addEventListener('click', () => showMenu($('#skillsMenuBtn'), [
  { text: 'Refresh data', icon: 'refresh-cw', run: async () => { await loadHistory(); toast('Dashboard refreshed'); } },
  { text: state.covN === 5 ? 'Show top 8 skills' : 'Show top 5 skills', icon: 'list-filter', run: () => { state.covN = state.covN === 5 ? 8 : 5; renderDashboard(); } },
  { sep: 1 },
  { text: 'View skill gaps', icon: 'arrow-up-right', run: () => { if (state.analysis) { showPage('results'); showTab('gaps'); } else showPage('analysis'); } },
]));

/* ---------- roadmap ---------- */
const SAMPLE_ROADMAP = [
  { title: 'TypeScript foundations', description: 'Build confidence with type annotations and interfaces.', tasks: ['Primitive & union types', 'Interfaces and type aliases', 'Typing functions and objects', 'Mini task: type a small API dataset'], hours: '5–7', priority: 'high' },
  { title: 'React + TypeScript', description: 'Combine React fundamentals with typed components.', tasks: ['Props & state types', 'Typed events', 'Reusable components', 'Mini task: build a task tracker'], hours: '6–8', priority: 'medium' },
  { title: 'Testing essentials', description: 'Learn how to validate UI behavior and functions.', tasks: ['Test fundamentals', 'Unit testing concepts', 'Assertions & test cases', 'Mini task: test utility functions'], hours: '5–6', priority: 'medium' },
  { title: 'Portfolio-ready project', description: 'Apply your learning in a focused project.', tasks: ['Plan project requirements', 'Implement typed components', 'Add tests for key logic', 'Document and publish'], hours: '8–10', priority: 'build' },
];
let roadmap = store.get('cm_roadmap', null) || { personalized: false, title: 'Build skills. Unlock opportunities.', sub: 'Prioritized based on gaps from your sample analysis.', weeks: SAMPLE_ROADMAP.map(w => ({ ...w, id: uid(), done: false })) };
const saveRoadmap = () => store.set('cm_roadmap', roadmap);
const PRIORITY = { high: 'HIGH PRIORITY', medium: 'MEDIUM', low: 'LOW', build: 'PROJECT' };
function renderRoadmap() {
  const w = roadmap.weeks;
  $('#roadmapPill').textContent = roadmap.personalized ? 'PERSONALIZED ROADMAP' : 'SAMPLE ROADMAP';
  $('#roadmapTitle').textContent = roadmap.title; $('#roadmapSub').textContent = roadmap.sub;
  $('#roadmapDays').textContent = w.length * 7;
  $('#roadmapClear').hidden = false;
  $('#roadmapGrid').innerHTML = w.length ? w.map((x, i) => `<article class="panel roadmap-card${x.done ? ' done' : ''}" data-rid="${x.id}"><div class="roadmap-card-head"><span class="week-badge">WEEK ${String(i + 1).padStart(2, '0')}</span><div class="card-tools"><span class="priority-tag ${esc(x.priority || 'medium')}">${PRIORITY[x.priority] || 'MEDIUM'}</span><button class="card-del" data-rdel="${x.id}" aria-label="Delete this week" title="Delete this week"><i class="icon icon-trash-2"></i></button></div></div><h3>${esc(x.title)}</h3><p>${esc(x.description)}</p><ul>${(x.tasks || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul><div class="roadmap-bottom"><span><i class="icon icon-clock"></i> ${esc(x.hours || '4–6')} hours</span><button class="check-week${x.done ? ' done' : ''}" data-rdone="${x.id}"><i class="icon icon-${x.done ? 'check-circle' : 'circle'}"></i> ${x.done ? 'Completed' : 'Mark complete'}</button></div></article>`).join('')
    : `<div class="empty-state panel roadmap-empty"><div class="empty-icon"><i class="icon icon-route"></i></div><h3>No roadmap yet</h3><p>Generate a personalized learning plan from your latest analysis, or load the sample roadmap.</p><div class="heading-actions" style="justify-content:center"><button class="btn-lime" data-rgen><i class="icon icon-sparkles"></i> Generate roadmap</button><button class="btn-outline" data-rsample>Load sample</button></div></div>`;
}
$('#roadmapGrid').addEventListener('click', e => {
  const del = e.target.closest('[data-rdel]'), done = e.target.closest('[data-rdone]');
  if (del) { roadmap.weeks = roadmap.weeks.filter(x => x.id !== del.dataset.rdel); saveRoadmap(); renderRoadmap(); toast('Roadmap week deleted'); }
  else if (done) { const x = roadmap.weeks.find(w => w.id === done.dataset.rdone); if (x) { x.done = !x.done; saveRoadmap(); renderRoadmap(); } }
  else if (e.target.closest('[data-rgen]')) generateRoadmap();
  else if (e.target.closest('[data-rsample]')) { roadmap = { personalized: false, title: 'Build skills. Unlock opportunities.', sub: 'Prioritized based on gaps from your sample analysis.', weeks: SAMPLE_ROADMAP.map(w => ({ ...w, id: uid(), done: false })) }; saveRoadmap(); renderRoadmap(); }
});
$('#roadmapClear').addEventListener('click', async () => {
  if (!await confirmBox('Clear the whole roadmap?', 'All weeks in this roadmap will be removed. You can generate a new one anytime.', 'Clear roadmap')) return;
  roadmap.weeks = []; saveRoadmap(); renderRoadmap(); toast('Roadmap cleared');
});
async function generateRoadmap() {
  const a = state.analysis || (state.history[0] && state.history[0].payload) || null;
  let gaps = a ? (a.gaps || []) : [], role = a ? a.role : '';
  if (!a) {
    const v = await modal({ title: 'Generate a roadmap', text: 'No analysis yet. Tell me which skills you want to learn (comma separated) or run an analysis for a personalized plan.', input: { label: 'Skills to learn', placeholder: 'e.g. TypeScript, Testing, Next.js', max: 200 }, ok: 'Generate' });
    if (v === null) return;
    gaps = v.split(',').map(s => s.trim()).filter(Boolean);
    if (!gaps.length) { toast('Enter at least one skill'); return; }
  }
  const btn = $('#roadmapGenerate'), label = btn.querySelector('span');
  btn.disabled = true; label.textContent = 'Generating…';
  try {
    const d = await postJSON('/api/roadmap', { gaps, role, field: a && a.field, job_description: a && (a.job_description || '') , weeks: 4 });
    roadmap = { personalized: true, title: 'Build skills. Unlock opportunities.', sub: a ? `Personalized from your ${a.role} match report.` : 'Built from the skills you chose.', weeks: (d.weeks || []).map(w => ({ ...w, id: uid(), done: false })) };
    saveRoadmap(); renderRoadmap();
    toast(d.warning ? `Roadmap generated (offline plan – ${d.warning})` : 'Personalized roadmap generated');
    notify('Roadmap ready', `${roadmap.weeks.length}-week learning plan generated.`, 'roadmap', 'route');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; label.textContent = 'Generate roadmap'; }
}
$('#roadmapGenerate').addEventListener('click', generateRoadmap);

/* ---------- chat ---------- */
function md(text) {
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  esc(text).split('\n').forEach(line => {
    let m;
    if ((m = line.match(/^\s*(?:[-*•])\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
    else if (!line.trim()) close();
    else { close(); html += `<p>${inline(line)}</p>`; }
  });
  close(); return html;
}
const chatMessages = $('#chatMessages'), chatInput = $('#chatInput'), chatForm = $('#chatForm');
const PROMPTS = ['Explain my missing skills', 'Build a 30-day learning plan', 'Help tailor my resume', 'Prepare interview questions'];
const welcomeHtml = () => `<div class="chat-welcome"><div class="welcome-orb"><i class="icon icon-sparkles"></i></div><h2>What would you like to<br>work on today?</h2><p>Ask about your match, skill gaps, resume or career direction.</p><div class="prompt-grid">${PROMPTS.map(p => `<button class="prompt-card" type="button">${p} <i class="icon icon-arrow-up-right"></i></button>`).join('')}</div></div>`;
function addMsg(role, text, { tool, raw } = {}) {
  chatMessages.querySelector('.chat-welcome')?.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  el.innerHTML = `<div class="msg-bubble">${raw || (role === 'user' ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : md(text))}</div>` +
    (role === 'user' || raw ? '' : `<div class="msg-meta">${tool ? `<span>Tool used: ${esc(tool)}</span>` : ''}<button class="msg-copy" type="button"><i class="icon icon-copy"></i> Copy</button></div>`);
  el._text = text;
  chatMessages.appendChild(el); chatMessages.scrollTop = chatMessages.scrollHeight;
  return el;
}
chatMessages.addEventListener('click', e => { const b = e.target.closest('.msg-copy'); if (b) copyText(b.closest('.msg')._text, 'Reply copied'); });
function resetChatView() { chatMessages.innerHTML = welcomeHtml(); $('#chatTitle').textContent = 'New chat'; }
function newChat() { state.chatId = null; resetChatView(); renderChatList(); closeChatDrawer(); chatInput.focus(); }
async function sendChat(text) {
  text = (text || '').trim();
  if (!text || state.busy) return;
  state.busy = true; $('#chatSend').disabled = true;
  addMsg('user', text);
  const wait = addMsg('bot', '', { raw: '<div class="typing"><i></i><i></i><i></i></div>' });
  const a = state.analysis;
  try {
    const d = await postJSON('/api/chat', { message: text, chat_id: state.chatId, analysis_id: a && a.id ? a.id : undefined, analysis: a && !a.id ? a : undefined });
    state.chatId = d.chat_id; $('#chatTitle').textContent = d.title || 'Chat';
    wait.remove(); addMsg('bot', d.reply, { tool: d.tool_used });
    loadChats();
  } catch (e) {
    wait.remove(); addMsg('bot', e.message || 'Something went wrong. Please try again.');
  } finally { state.busy = false; $('#chatSend').disabled = false; chatInput.focus(); }
}
chatForm.addEventListener('submit', e => { e.preventDefault(); const t = chatInput.value; chatInput.value = ''; chatInput.style.height = ''; sendChat(t); });
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatForm.requestSubmit(); } });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + 'px'; });
$('#newChat').addEventListener('click', newChat); $('#newChat2').addEventListener('click', newChat);

async function loadChats() {
  try { state.chats = await api('/api/chats'); renderChatList(); } catch { /* offline */ }
}
function renderChatList() {
  $('#chatList').innerHTML = state.chats.length ? state.chats.map(c => `<div class="chat-row${c.id === state.chatId ? ' active' : ''}"><button class="chat-open" data-chat="${c.id}"><strong>${esc(c.title)}</strong><small>${timeAgo(c.updated)} · ${Math.ceil(c.count / 2)} ${Math.ceil(c.count / 2) === 1 ? 'message' : 'messages'}</small></button><button class="chat-del" data-chatdel="${c.id}" aria-label="Delete chat" title="Delete chat"><i class="icon icon-trash-2"></i></button></div>`).join('') : '<p class="empty-note">No conversations yet. Say hello to start one!</p>';
  $('#chatClearAll').hidden = !state.chats.length;
}
$('#chatList').addEventListener('click', e => {
  const open = e.target.closest('[data-chat]'), del = e.target.closest('[data-chatdel]');
  if (open) openChat(+open.dataset.chat); else if (del) deleteChat(+del.dataset.chatdel);
});
async function openChat(id) {
  try {
    const d = await api('/api/chats/' + id);
    state.chatId = d.id; chatMessages.innerHTML = ''; $('#chatTitle').textContent = d.title;
    d.messages.forEach(m => addMsg(m.role, m.content, { tool: m.tool }));
    renderChatList(); closeChatDrawer();
  } catch (e) { toast(e.message); loadChats(); }
}
async function deleteChat(id) {
  const c = state.chats.find(x => x.id === id);
  if (!await confirmBox('Delete this chat?', c ? `“${c.title}” will be removed permanently.` : '')) return;
  try {
    await api('/api/chats/' + id, { method: 'DELETE' });
    if (Number(state.chatId) === Number(id)) { state.chatId = null; resetChatView(); }
    state.chats = state.chats.filter(x => Number(x.id) !== Number(id));
    closeChatDrawer();
    renderChatList();
    await loadChats();
    renderChatList();
    toast('Chat deleted');
  } catch (e) { toast(e.message); }
}
$('#chatClearAll').addEventListener('click', clearAllChats);
async function clearAllChats() {
  if (!await confirmBox('Delete all chats?', 'Your entire chat history will be removed permanently.', 'Delete all')) return;
  try {
    await api('/api/chats', { method: 'DELETE' });
    state.chatId = null; state.chats = []; resetChatView(); closeChatDrawer(); renderChatList();
    await loadChats();
    renderChatList();
    toast('Chat history cleared');
  } catch (e) { toast(e.message); }
}
async function renameChat() {
  if (!state.chatId) { toast('Start a conversation first'); return; }
  const v = await modal({ title: 'Rename chat', input: { label: 'Chat title', value: $('#chatTitle').textContent, max: 80 }, ok: 'Save' });
  if (!v) return;
  try { const d = await postJSON('/api/chats/' + state.chatId, { title: v }, 'PATCH'); $('#chatTitle').textContent = d.title; loadChats(); toast('Chat renamed'); } catch (e) { toast(e.message); }
}
function exportChat() {
  const msgs = $$('.msg', chatMessages).filter(m => !m.querySelector('.typing'));
  if (!msgs.length) { toast('Nothing to export yet'); return; }
  const title = $('#chatTitle').textContent;
  download(`CareerMatch-Chat-${safeName(title)}.txt`, `CareerMatch AI chat – ${title}\n${'='.repeat(40)}\n\n` + msgs.map(m => `${m.classList.contains('user') ? 'You' : 'Career AI'}:\n${m._text}\n`).join('\n'));
  toast('Chat exported');
}
$('#chatMenuBtn').addEventListener('click', () => showMenu($('#chatMenuBtn'), [
  { text: 'New chat', icon: 'plus', run: newChat },
  { text: 'Rename chat', icon: 'pencil', run: renameChat },
  { text: 'Export chat (.txt)', icon: 'download', run: exportChat },
  { sep: 1 },
  { text: 'Delete this chat', icon: 'trash-2', danger: true, run: () => state.chatId ? deleteChat(state.chatId) : toast('This chat is not saved yet') },
  { text: 'Delete all chats', icon: 'trash-2', danger: true, run: clearAllChats },
]));
const chatDrawer = $('#chatHistory');
function closeChatDrawer() { if (chatDrawer.classList.contains('open')) { chatDrawer.classList.remove('open'); if (!sidebar.classList.contains('open')) overlay.classList.remove('show'); } }
$('#chatHistoryToggle').addEventListener('click', e => { e.stopPropagation(); closePop(); chatDrawer.classList.add('open'); overlay.classList.add('show'); loadChats(); });
$('#chatHistoryClose').addEventListener('click', closeChatDrawer);
document.addEventListener('click', e => { if (chatDrawer.classList.contains('open') && !chatDrawer.contains(e.target) && !e.target.closest('#chatHistoryToggle') && !e.target.closest('#modal')) closeChatDrawer(); });

/* ---------- status / settings actions ---------- */
async function loadStatus() {
  try {
    const d = await api('/api/status'); state.aiOn = d.api_configured; state.model = d.model;
    const el = $('#page-settings .api-status'); if (el) el.textContent = d.api_configured ? 'Gemini API connected · ' + d.model : 'Gemini API not configured · Local skill matching is available';
    $('#chatStatus').innerHTML = `<span class="status-dot"></span> ${d.api_configured ? 'Gemini connected · AI chat enabled' : 'Offline mode · add GEMINI_API_KEY for full AI answers'}`;
  } catch { $('#chatStatus').innerHTML = '<span class="status-dot" style="background:#ff7878;box-shadow:none"></span> Server not reachable'; }
}
$('#clearHistoryBtn').addEventListener('click', async () => {
  if (!await confirmBox('Delete all saved analyses?', 'This removes every saved analysis permanently.', 'Delete all')) return;
  try {
    await api('/api/history', { method: 'DELETE' });
    state.analysis = null; state.history = []; clearResults();
    renderHistory(); renderDashboard();
    await loadHistory();
    renderHistory(); renderDashboard();
    toast('History cleared');
  } catch (e) { toast(e.message); }
});
$('#clearChatsBtn').addEventListener('click', clearAllChats);

/* ---------- init ---------- */
resetChatView(); renderRoadmap(); renderDashboard(); renderHistory(); clearResults();
loadStatus();
loadHistory().then(() => { const h = location.hash.slice(1); if (pageNames[h] && h !== 'dashboard') showPage(h); });
if (pageNames[location.hash.slice(1)]) { const h = location.hash.slice(1); pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + h)); $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === h)); }
