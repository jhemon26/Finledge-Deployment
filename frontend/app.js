(() => {
  'use strict';

  const API = '';
  const GROUP_ORDER = ['Day-to-day', 'Bills & Fixed Costs'];

  const state = {
    token: null,
    room: null,
    member: null,
    members: [],
    categories: [],
    categoryGroups: [],
    categoryByName: {},
    categoryIconLibrary: [],
    categoryColors: [],
    avatars: [],
    // Home's list: the live month, always. Home is never history.
    expenses: [],
    // Activity's list: whichever month the month bar is on.
    historyExpenses: [],
    activity: [],
    analytics: null,
    // Home's own copy, always the live month. Points at `analytics` whenever
    // Activity happens to be on the live month too, so no second request.
    homeAnalytics: null,
    // The month Activity is browsing, which Analytics follows. This is
    // navigation, not a filter: it always has a value, and clearing the
    // filters leaves it alone. Home ignores it entirely. The server is the
    // authority on which months exist — `availableMonths` is its last answer.
    activeMonth: null,
    availableMonths: [],
    isCurrentMonth: true,
    // The month the rows currently in historyExpenses were fetched for. The
    // History summary is captioned from this, not from isCurrentMonth, which
    // a parallel analytics request may not have updated yet.
    historyMonth: null,
    // The months still open for entry, as the server sees them. Everything
    // the UI allows is derived from this, never from a local guess.
    writeWindow: null,
    // When the user last chose a month by hand. A history month is a place
    // you visited, not a setting — see maybeReturnToLiveMonth().
    monthTouchedAt: 0,
    // Settle-up requests waiting on this member, in any month — a request can
    // be raised for a month they are not currently looking at.
    pendingSettleRequests: [],
    filters: { member: '', category: '', q: '' },
    ws: null,
    editingExpenseId: null,
    editingCategoryId: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------------
  // Identity rendering
  //
  // A tint is never a fill. `.tint-<key>` sets the glyph colour, a 9% wash
  // and a 26% rule on whatever well contains it, plus the glyph's
  // counter-tone. The colour keys are the ones stored in the database, so
  // nothing here needs a migration.
  // ---------------------------------------------------------------------
  function avatarHtml(avatarKey, sizeClass) {
    const [tint, glyph] = (avatarKey || 'ocean-wave').split('-');
    return `<span class="avatar ${sizeClass} tint-${tint}"><svg><use href="#avatar-${glyph}"/></svg></span>`;
  }

  function catIconHtml(categoryName, wrapClass) {
    const cat = state.categoryByName[categoryName];
    const icon = cat ? cat.icon : 'cat-shopping';
    const color = cat ? cat.color : 'indigo';
    return `<span class="${wrapClass} tint-${color}"><svg><use href="#${icon}"/></svg></span>`;
  }

  function categoryTint(name) {
    const c = state.categoryByName[name];
    return c ? c.color : 'indigo';
  }

  function buildCategoryGroups(categories) {
    const byGroup = new Map();
    for (const c of categories) {
      if (!byGroup.has(c.groupName)) byGroup.set(c.groupName, []);
      byGroup.get(c.groupName).push(c);
    }
    const orderedNames = [...GROUP_ORDER, ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g))];
    return orderedNames.filter((g) => byGroup.has(g)).map((name) => ({ name, categories: byGroup.get(name) }));
  }

  // ---------------------------------------------------------------------
  // Local credential cache (session token + convenience copies for Profile)
  // ---------------------------------------------------------------------
  const STORAGE_KEY = 'finledge_session';

  function saveCreds(data, remember) {
    const payload = JSON.stringify(data);
    if (remember) {
      localStorage.setItem(STORAGE_KEY, payload);
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, payload);
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function loadCreds() {
    const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearCreds() {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  // ---------------------------------------------------------------------
  // API helper
  // ---------------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(API + path, { ...opts, headers });
    let body = null;
    try { body = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------
  function money(n) {
    return `£${Number(n || 0).toFixed(2)}`;
  }
  function moneyShort(n) {
    const v = Number(n || 0);
    if (Math.abs(v) >= 1000) return `£${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return `£${v.toFixed(0)}`;
  }
  function formatDateLabel(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function dayHeadingLabel(iso) {
    const d = new Date(iso + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today - d) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function monthLabel(ym) {
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  function monthLabelLong(ym) {
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  // Short but unambiguous — "Aug 2026", not "Aug 26", which reads as a date.
  function monthLabelShort(ym) {
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  // Matches the UTC basis the server uses for the same question.
  function currentMonthKey() {
    return new Date().toISOString().slice(0, 7);
  }
  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }
  function addMonthsKey(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const i = y * 12 + (m - 1) + n;
    return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------
  // The write window, client side
  //
  // The server is the authority and rejects anything outside it — this is only
  // so the UI never *offers* a date it would then refuse. It uses the window
  // the server sent, and falls back to the same arithmetic if we have not
  // heard from it yet (first paint, offline reconnect).
  // ---------------------------------------------------------------------
  const GRACE_DAYS_FALLBACK = 7;

  function writeWindow() {
    if (state.writeWindow) return state.writeWindow;
    const today = todayKey();
    const current = today.slice(0, 7);
    const inGrace = Number(today.slice(8, 10)) <= GRACE_DAYS_FALLBACK;
    const months = inGrace ? [addMonthsKey(current, -1), current] : [current];
    return {
      today,
      months,
      currentMonth: current,
      graceDays: GRACE_DAYS_FALLBACK,
      graceMonth: inGrace ? months[0] : null,
      graceEndsOn: inGrace ? `${current}-${String(GRACE_DAYS_FALLBACK).padStart(2, '0')}` : null,
      minDate: `${months[0]}-01`,
      maxDate: today,
    };
  }

  function monthIsWritable(ym) {
    return writeWindow().months.includes(ym);
  }

  function dateIsWritable(iso) {
    const w = writeWindow();
    return !!iso && iso >= w.minDate && iso <= w.maxDate && monthIsWritable(iso.slice(0, 7));
  }
  function absDate(iso) {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function absDateTime(iso) {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function relTime(iso) {
    const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
    const diffSec = Math.max(1, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  // =======================================================================
  // BOOTSTRAP
  // =======================================================================
  async function loadMeta() {
    const meta = await api('/api/meta');
    state.avatars = meta.avatars;
    state.categoryIconLibrary = meta.categoryIconLibrary;
    state.categoryColors = meta.categoryColors;
    assignRandomAvatar('join-avatar');
    assignRandomAvatar('create-avatar');
  }

  // New members don't pick an avatar at sign-up — one is assigned at random
  // so the login screen stays to the point; it's changeable from Profile.
  function assignRandomAvatar(hiddenId) {
    if (!state.avatars.length) return;
    const el = $(`#${hiddenId}`);
    if (el) el.value = state.avatars[Math.floor(Math.random() * state.avatars.length)];
  }

  async function refreshCategories() {
    state.categories = await api('/api/categories');
    state.categoryGroups = buildCategoryGroups(state.categories);
    state.categoryByName = {};
    for (const c of state.categories) state.categoryByName[c.name] = c;
  }

  function openAvatarModal() {
    const grid = $('#profile-avatar-grid');
    grid.innerHTML = state.avatars
      .map((key) => {
        const [tint] = key.split('-');
        return `
        <button type="button" class="avatar-option tint-${tint}${key === state.member.avatar ? ' selected' : ''}" data-avatar="${key}">
          ${avatarHtml(key, 'avatar-md')}
          <span class="avatar-option-check"><svg><use href="#icon-check"/></svg></span>
        </button>`;
      })
      .join('');
    grid.querySelectorAll('.avatar-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const avatar = btn.dataset.avatar;
        try {
          const member = await api('/api/member/avatar', { method: 'PATCH', body: JSON.stringify({ avatar }) });
          state.member.avatar = member.avatar;
          renderProfile();
          await Promise.all([refreshAll(), refreshMembers()]);
          toast('Avatar updated');
          $('#avatar-modal').classList.add('hidden');
        } catch (err) {
          toast(err.message);
        }
      });
    });
    $('#avatar-modal').classList.remove('hidden');
  }

  function initAvatarModal() {
    $('#avatar-modal-close').addEventListener('click', () => $('#avatar-modal').classList.add('hidden'));
    $('#avatar-modal').addEventListener('click', (e) => { if (e.target.id === 'avatar-modal') $('#avatar-modal').classList.add('hidden'); });
  }

  // =======================================================================
  // MANAGE CATEGORIES (host only)
  // =======================================================================
  function renderManageCategoriesList() {
    const wrap = $('#manage-categories-list');
    wrap.innerHTML = state.categoryGroups
      .map((g) => `
        <div class="category-manage-group-title">${escapeHtml(g.name)}</div>
        ${g.categories
          .map((c) => `
            <div class="category-manage-item">
              ${catIconHtml(c.name, 'cat-icon-wrap')}
              <span class="category-manage-name">${escapeHtml(c.name)}</span>
              <span class="category-manage-actions">
                <button class="icon-btn-sm" data-action="edit-cat" data-id="${c.id}" aria-label="Edit"><svg class="icon-sm"><use href="#icon-edit"/></svg></button>
                <button class="icon-btn-sm" data-action="delete-cat" data-id="${c.id}" aria-label="Delete"><svg class="icon-sm"><use href="#icon-trash"/></svg></button>
              </span>
            </div>`)
          .join('')}
        <button type="button" class="add-category-btn" data-add-group="${escapeHtml(g.name)}"><svg class="icon-sm"><use href="#icon-plus"/></svg> Add to ${escapeHtml(g.name)}</button>`)
      .join('');

    wrap.querySelectorAll('[data-action="edit-cat"]').forEach((b) =>
      b.addEventListener('click', () => openCategoryEditModal(state.categories.find((c) => c.id === Number(b.dataset.id))))
    );
    wrap.querySelectorAll('[data-action="delete-cat"]').forEach((b) =>
      b.addEventListener('click', () => confirmDeleteCategory(Number(b.dataset.id)))
    );
    wrap.querySelectorAll('[data-add-group]').forEach((b) =>
      b.addEventListener('click', () => openCategoryEditModal(null, b.dataset.addGroup))
    );
  }

  function initManageCategories() {
    $('#manage-categories-btn').addEventListener('click', () => {
      renderManageCategoriesList();
      $('#manage-categories-modal').classList.remove('hidden');
    });
    $('#manage-categories-close').addEventListener('click', () => $('#manage-categories-modal').classList.add('hidden'));
    $('#manage-categories-modal').addEventListener('click', (e) => { if (e.target.id === 'manage-categories-modal') $('#manage-categories-modal').classList.add('hidden'); });
  }

  function confirmDeleteCategory(id) {
    const c = state.categories.find((x) => x.id === id);
    if (!c) return;
    openConfirm({
      title: 'Delete this category?',
      body: `"${c.name}" will no longer be selectable. Past transactions keep their category label.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api(`/api/categories/${id}`, { method: 'DELETE' });
        toast('Category deleted');
        await refreshCategories();
        buildCategoryGrid();
        populateFilterOptions();
        renderManageCategoriesList();
      },
    });
  }

  // ---------------------------------------------------------------------
  // Add / edit category form
  // ---------------------------------------------------------------------
  // The icon grid previews every glyph in the colour currently selected
  // below it, so the host sees the actual pairing before saving.
  function buildIconPicker(selectedIcon, selectedColor) {
    const grid = $('#category-edit-icon-grid');
    grid.className = `icon-picker-grid tint-${selectedColor || 'indigo'}`;
    grid.innerHTML = state.categoryIconLibrary
      .map((icon) => `<button type="button" class="icon-picker-option${icon === selectedIcon ? ' selected' : ''}" data-icon="${icon}" aria-label="${icon}"><svg><use href="#${icon}"/></svg></button>`)
      .join('');
    grid.querySelectorAll('.icon-picker-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.icon-picker-option').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        $('#category-edit-icon').value = btn.dataset.icon;
      });
    });
  }

  function retintIconPicker(color) {
    $('#category-edit-icon-grid').className = `icon-picker-grid tint-${color}`;
  }

  function buildColorPicker(selectedColor) {
    const row = $('#category-edit-color-row');
    row.innerHTML = state.categoryColors
      .map((color) => `<button type="button" class="color-picker-option tint-${color}${color === selectedColor ? ' selected' : ''}" data-color="${color}" aria-label="${color}"></button>`)
      .join('');
    row.querySelectorAll('.color-picker-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.color-picker-option').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        $('#category-edit-color').value = btn.dataset.color;
        retintIconPicker(btn.dataset.color);
      });
    });
  }

  function openCategoryEditModal(category, defaultGroup) {
    state.editingCategoryId = category ? category.id : null;
    $('#category-edit-error').textContent = '';
    const group = category ? category.groupName : (defaultGroup || 'Day-to-day');

    $('#category-edit-title').textContent = category ? 'Edit category' : 'Add category';
    $('#category-edit-id').value = category ? category.id : '';
    $('#category-edit-name').value = category ? category.name : '';
    $('#category-edit-group').value = group;
    $$('#category-edit-form .segmented-btn').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
    $('#category-edit-icon').value = category ? category.icon : '';
    $('#category-edit-color').value = category ? category.color : '';
    buildIconPicker(category ? category.icon : null, category ? category.color : 'indigo');
    buildColorPicker(category ? category.color : null);
    $('#category-edit-danger-zone').classList.toggle('hidden', !category);

    $('#category-edit-modal').classList.remove('hidden');
  }

  function closeCategoryEditModal() {
    $('#category-edit-modal').classList.add('hidden');
    state.editingCategoryId = null;
  }

  function initCategoryEditModal() {
    $('#category-edit-close').addEventListener('click', closeCategoryEditModal);
    $('#category-edit-modal').addEventListener('click', (e) => { if (e.target.id === 'category-edit-modal') closeCategoryEditModal(); });

    $$('#category-edit-form .segmented-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#category-edit-form .segmented-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $('#category-edit-group').value = btn.dataset.group;
      });
    });

    $('#category-edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#category-edit-error');
      errEl.textContent = '';

      const icon = $('#category-edit-icon').value;
      const color = $('#category-edit-color').value;
      if (!icon) { errEl.textContent = 'Please choose an icon'; return; }
      if (!color) { errEl.textContent = 'Please choose a colour'; return; }

      const payload = {
        name: $('#category-edit-name').value.trim(),
        groupName: $('#category-edit-group').value,
        icon,
        color,
      };

      try {
        if (state.editingCategoryId) {
          await api(`/api/categories/${state.editingCategoryId}`, { method: 'PUT', body: JSON.stringify(payload) });
          toast('Category updated');
        } else {
          await api('/api/categories', { method: 'POST', body: JSON.stringify(payload) });
          toast('Category added');
        }
        await refreshCategories();
        buildCategoryGrid();
        populateFilterOptions();
        await refreshExpenses();
        renderManageCategoriesList();
        closeCategoryEditModal();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    $('#category-edit-delete').addEventListener('click', () => {
      const id = state.editingCategoryId;
      closeCategoryEditModal();
      if (id) confirmDeleteCategory(id);
    });
  }

  async function boot() {
    const splashStart = Date.now();
    const creds = loadCreds();

    const finishSplash = () => {
      const elapsed = Date.now() - splashStart;
      const wait = Math.max(0, 600 - elapsed);
      setTimeout(() => $('#splash').classList.add('hidden'), wait);
    };

    if (creds && creds.token) {
      state.token = creds.token;
      try {
        const session = await api('/api/session');
        state.room = session.room;
        state.member = session.member;
        state._cachedRoomPassword = creds.roomPassword || null;
        state._cachedPin = creds.memberPin || null;
        await enterApp();
        finishSplash();
        maybeStartTour();
        return;
      } catch (_) {
        clearCreds();
      }
    }
    finishSplash();
    showAuth();
  }

  function showAuth() {
    $('#auth-screen').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }

  // =======================================================================
  // AUTH SCREEN
  // =======================================================================
  function showAuthWelcome() {
    $('#auth-welcome').classList.remove('hidden');
    $('#form-join').classList.add('hidden');
    $('#form-create').classList.add('hidden');
  }

  function showAuthForm(mode) {
    $('#auth-welcome').classList.add('hidden');
    $('#form-join').classList.toggle('hidden', mode !== 'join');
    $('#form-create').classList.toggle('hidden', mode !== 'create');
  }

  function initAuthScreen() {
    $('#choice-join').addEventListener('click', () => { assignRandomAvatar('join-avatar'); showAuthForm('join'); });
    $('#choice-create').addEventListener('click', () => { assignRandomAvatar('create-avatar'); showAuthForm('create'); });
    $$('.auth-back-btn').forEach((btn) => btn.addEventListener('click', showAuthWelcome));

    $('#form-join').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#join-error');
      errEl.textContent = '';
      const roomId = $('#join-roomId').value.trim().toUpperCase();
      const roomPassword = $('#join-roomPassword').value;
      const memberName = $('#join-memberName').value.trim();
      const memberPin = $('#join-memberPin').value;
      const avatar = $('#join-avatar').value;
      const remember = $('#join-remember').checked;
      try {
        const res = await api('/api/rooms/join', {
          method: 'POST',
          body: JSON.stringify({ roomId, roomPassword, memberName, memberPin, avatar }),
        });
        completeAuth(res, { roomPassword, memberPin }, remember);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    $('#form-create').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#create-error');
      errEl.textContent = '';
      const roomName = $('#create-roomName').value.trim();
      const roomPassword = $('#create-roomPassword').value;
      const hostName = $('#create-hostName').value.trim();
      const hostPin = $('#create-hostPin').value;
      const avatar = $('#create-avatar').value;
      const remember = $('#create-remember').checked;
      try {
        const res = await api('/api/rooms/create', {
          method: 'POST',
          body: JSON.stringify({ roomName, roomPassword, hostName, hostPin, avatar }),
        });
        completeAuth(res, { roomPassword, memberPin: hostPin }, remember);
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  async function completeAuth(res, secrets, remember) {
    state.token = res.token;
    state.room = res.room;
    state.member = res.member;
    state._cachedRoomPassword = secrets.roomPassword;
    state._cachedPin = secrets.memberPin;
    saveCreds({ token: res.token, roomPassword: secrets.roomPassword, memberPin: secrets.memberPin }, remember);
    $('#auth-screen').classList.add('hidden');
    await enterApp();
    maybeStartTour();
  }

  // =======================================================================
  // MAIN APP
  // =======================================================================
  async function enterApp() {
    $('#app').classList.remove('hidden');
    $('#topbar-room').textContent = `${state.room.name} · ${state.room.id}`;
    // Home is already the active view in the markup; going through switchView
    // keeps everything that depends on the view — the FAB and the topbar month
    // chip — derived in one place rather than initialised twice.
    switchView('home');

    // Every session starts on the live month. History is somewhere you go,
    // never somewhere you are left — reopening the app is one of the two ways
    // out of it (the other is maybeReturnToLiveMonth on idle).
    state.activeMonth = currentMonthKey();
    state.monthTouchedAt = Date.now();

    await refreshCategories();
    await Promise.all([refreshMembers(), refreshExpenses(), refreshHistoryExpenses(), refreshActivity(), refreshAnalytics(), refreshRoom()]);

    buildCategoryGrid();
    populateFilterOptions();
    renderProfile();
    connectWs();
  }

  function connectWs() {
    if (state.ws) { try { state.ws.close(); } catch (_) {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.addEventListener('message', async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.activity) prependActivity(msg.activity);

      if (['expense_added', 'expense_updated', 'expense_deleted'].includes(msg.type)) {
        await refreshAll();
      }
      // The request itself arrives here — this is how "everyone receives it".
      // Members who are offline pick it up from the panel, the Analytics dot
      // and the activity log next time they open the app.
      if (msg.type === 'settlement_changed') {
        await refreshAnalytics();
        if (msg.byId !== state.member.id) {
          const when = msg.month ? monthLabelLong(msg.month) : 'a month';
          if (msg.status === 'pending') toast(`${msg.by} asked everyone to settle up ${when}`);
          else if (msg.status === 'settled') toast(`${when} is settled up`);
          else toast(`${msg.by} withdrew the ${when} settle-up`);
        }
      }
      // Participation and the host both change what other people can do, so
      // they land like any other mutation: refresh, then say what happened.
      if (msg.type === 'participation_changed') {
        await refreshAll();
        renderProfile();
        if (msg.activity && msg.activity.memberName !== state.member.name) toast(msg.activity.message);
      }
      if (msg.type === 'host_changed') {
        await Promise.all([refreshMembers(), refreshSession()]);
        await refreshAll();
        renderProfile();
        toast(msg.hostId === state.member.id ? 'You are now the host' : (msg.activity ? msg.activity.message : 'The host changed'));
      }
      if (msg.type === 'member_joined') {
        await Promise.all([refreshMembers(), refreshRoom()]);
        populateFilterOptions();
        toast(`${msg.member.name} joined the room`);
      }
      if (msg.type === 'member_updated') {
        if (msg.member.id === state.member.id) {
          state.member.avatar = msg.member.avatar;
          // Was avatar-only, which left your own name stale after a rename.
          state.member.name = msg.member.name;
        }
        await Promise.all([refreshMembers(), refreshExpenses(), refreshHistoryExpenses(), refreshActivity(), refreshAnalytics()]);
        renderProfile();
      }
      if (msg.type === 'categories_changed') {
        await refreshCategories();
        buildCategoryGrid();
        populateFilterOptions();
        await Promise.all([refreshExpenses(), refreshHistoryExpenses(), refreshAnalytics()]);
        if (!$('#manage-categories-modal').classList.contains('hidden')) renderManageCategoriesList();
        toast('Categories were updated by the host');
      }
    });

    ws.addEventListener('close', () => {
      if (state.token) setTimeout(connectWs, 2500);
    });
  }

  // ---------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------
  async function refreshMembers() {
    state.members = await api('/api/members');
  }

  // Your own row on the server, re-read. Needed after a host handover, which
  // changes is_host underneath a session that is otherwise still valid — and
  // every host-gated control renders off state.member.isHost.
  async function refreshSession() {
    const session = await api('/api/session');
    if (session && session.member) state.member = session.member;
  }

  async function refreshRoom() {
    const room = await api('/api/room');
    state.roomInfo = room;
    renderProfile();
  }

  // Home's query: the live month, unfiltered. Search and filters moved to
  // History, which is where you go looking for something.
  async function refreshExpenses() {
    state.expenses = await api(`/api/expenses?month=${encodeURIComponent(currentMonthKey())}`);
    renderTransactions();
  }

  function isFiltered() {
    const f = state.filters;
    return !!(f.member || f.category || f.q);
  }

  // History's list: whichever month the bar is on, narrowed by the search box
  // and filters above it.
  async function refreshHistoryExpenses() {
    const month = state.activeMonth || currentMonthKey();
    const p = new URLSearchParams();
    p.set('month', month);
    if (state.filters.member) p.set('memberId', state.filters.member);
    if (state.filters.category) p.set('category', state.filters.category);
    if (state.filters.q) p.set('q', state.filters.q);
    state.historyExpenses = await api(`/api/expenses?${p.toString()}`);
    // Remember which month these rows are, so the summary above them can name
    // it without waiting on the analytics call to land — the two are fetched
    // in parallel and either can win.
    state.historyMonth = month;
    renderHistoryTransactions();
  }

  // Unscoped on purpose: Activity answers "what has been happening", which is
  // not a question about a particular month. Month-scoped reading lives in
  // History now.
  async function refreshActivity() {
    state.activity = await api('/api/activity?limit=60');
    renderActivity();
  }

  async function refreshAnalytics() {
    const q = state.activeMonth ? `?month=${encodeURIComponent(state.activeMonth)}` : '';
    state.analytics = await api('/api/analytics' + q);
    // The server resolves the month it actually served — on first load we ask
    // for nothing and adopt its answer, and if a month ever falls out of the
    // retention window it corrects us here rather than leaving us stranded.
    state.activeMonth = state.analytics.month;
    state.availableMonths = state.analytics.availableMonths || [];
    state.isCurrentMonth = !!state.analytics.isCurrentMonth;
    state.writeWindow = state.analytics.writeWindow || null;
    state.pendingSettleRequests = state.analytics.pendingSettleRequests || [];
    renderMonthBar();
    renderPendingBadge();
    renderAnalytics();
    await refreshHomeAnalytics();
  }

  // Home's figures are the live month's, whatever Activity is browsing. When
  // the two agree — the common case — one request serves both.
  // Every mutation touches both lists — the live one on Home and the browsed
  // one in Activity — plus the analytics that describes each. Routing them all
  // through one call is what keeps the two from drifting apart.
  async function refreshAll() {
    await Promise.all([refreshExpenses(), refreshHistoryExpenses(), refreshActivity(), refreshAnalytics(), refreshRoom()]);
  }

  async function refreshHomeAnalytics() {
    const now = currentMonthKey();
    if (state.analytics && state.analytics.month === now) {
      state.homeAnalytics = state.analytics;
    } else {
      state.homeAnalytics = await api(`/api/analytics?month=${encodeURIComponent(now)}`);
      state.writeWindow = state.homeAnalytics.writeWindow || state.writeWindow;
    }
    renderHomeHero();
  }

  // A settle-up someone is waiting on you for is easy to never see: it may
  // have been raised for a month you are not viewing, and the panel that shows
  // it is a tab away. The dot is the only thing that crosses both gaps.
  function renderPendingBadge() {
    const dot = $('#nav-analytics-dot');
    if (dot) dot.classList.toggle('hidden', state.pendingSettleRequests.length === 0);
  }

  // ---------------------------------------------------------------------
  // Month navigation
  //
  // One control, in one place: the bar at the top of Activity. Home is always
  // the live month, so the only thing a month choice can change is the history
  // you are reading and the Analytics that describes it.
  //
  // The bar is "Previous" plus the last two months, because in practice people
  // want either this month or the one that just ended — those are one tap, and
  // anything older is one tap plus a list.
  // ---------------------------------------------------------------------
  const MONTH_CHIP_COUNT = 2;

  // The chips: the two newest months, plus the selected one if it is older, so
  // where you are is always visible on the bar and never only inside a dialog.
  function monthChipKeys() {
    const all = state.availableMonths;
    if (!all.length) return state.activeMonth ? [state.activeMonth] : [];
    const chips = all.slice(-MONTH_CHIP_COUNT);
    if (state.activeMonth && !chips.includes(state.activeMonth)) chips.unshift(state.activeMonth);
    return chips;
  }

  function renderMonthBar() {
    const month = state.activeMonth;
    if (!month) return;
    const now = currentMonthKey();

    const chips = $('#month-bar-chips');
    if (chips) {
      chips.innerHTML = monthChipKeys()
        .map((m) => {
          const cls = ['month-chip'];
          if (m === month) cls.push('is-active');
          if (m === now) cls.push('is-live');
          return `<button type="button" class="${cls.join(' ')}" data-month-chip="${escapeHtml(m)}">
              <span class="month-chip-name">${escapeHtml(monthChipLabel(m))}</span>
              ${m === now ? '<span class="month-chip-tag">Live</span>' : ''}
            </button>`;
        })
        .join('');
      chips.querySelectorAll('[data-month-chip]').forEach((b) =>
        b.addEventListener('click', () => goToMonth(b.dataset.monthChip, { manual: true }))
      );
    }

    // "Previous" is dead weight when there is nothing behind the chips.
    const prevBtn = $('#month-picker-btn');
    if (prevBtn) prevBtn.disabled = state.availableMonths.length <= monthChipKeys().length;

    // The topbar chip is the standing reminder that Analytics and this list
    // are not describing the month you are living in.
    const chip = $('#topbar-month');
    if (chip) {
      chip.classList.toggle('is-history', !state.isCurrentMonth);
      $('#topbar-month-name').textContent = monthLabelShort(month);
      $('#topbar-month-tag').textContent = state.isCurrentMonth ? '' : month < now ? 'Past month' : 'Future';
      chip.title = state.isCurrentMonth
        ? `Viewing ${monthLabelLong(month)}`
        : `Viewing ${monthLabelLong(month)} — not the current month. Tap to change.`;
    }

    const txNote = $('#history-tx-note');
    if (txNote) txNote.textContent = state.isCurrentMonth ? 'This month' : monthLabelShort(month);

    scheduleHistoryReset();
  }

  // A chip is small, so the year is only spelled out when leaving it off would
  // be ambiguous — a month from another year.
  function monthChipLabel(ym) {
    const thisYear = currentMonthKey().slice(0, 4);
    return ym.slice(0, 4) === thisYear ? monthLabelLong(ym).replace(/\s+\d{4}$/, '') : monthLabelShort(ym);
  }

  async function goToMonth(month, { manual = false } = {}) {
    if (manual) state.monthTouchedAt = Date.now();
    // Re-render on the no-op paths too, so a control that was mid-gesture is
    // always put back to where the app actually is.
    if (!month || month === state.activeMonth) { renderMonthBar(); return; }
    if (state.availableMonths.length && !state.availableMonths.includes(month)) {
      toast('That month is outside the 18 months kept in history');
      renderMonthBar();
      return;
    }
    state.activeMonth = month;
    renderMonthBar(); // move the label immediately; the data follows
    await Promise.all([refreshHistoryExpenses(), refreshActivity(), refreshAnalytics()]);
  }

  // ---------------------------------------------------------------------
  // Returning to the live month by itself
  //
  // A past month is somewhere you went to look at something, not a setting you
  // meant to leave switched on. Coming back to the app hours later still
  // parked on June — and reading June's totals as if they were now — is the
  // mistake this prevents. Home is already immune (it never leaves the live
  // month); this covers Activity and Analytics.
  // ---------------------------------------------------------------------
  const HISTORY_IDLE_MS = 10 * 60 * 1000;
  let historyIdleTimer = null;

  function scheduleHistoryReset() {
    clearTimeout(historyIdleTimer);
    if (state.isCurrentMonth) return;
    historyIdleTimer = setTimeout(() => maybeReturnToLiveMonth(), HISTORY_IDLE_MS);
  }

  async function maybeReturnToLiveMonth() {
    if (!state.token || state.isCurrentMonth) return;
    if (Date.now() - state.monthTouchedAt < HISTORY_IDLE_MS) { scheduleHistoryReset(); return; }
    const was = state.activeMonth;
    await goToMonth(currentMonthKey());
    // Say it happened. A view that silently rearranged itself is worse than
    // one that stayed put.
    if (state.activeMonth !== was) toast(`Back to ${monthLabelLong(state.activeMonth)} — history closes itself after a while`);
  }

  function initMonthBar() {
    $('#month-picker-btn').addEventListener('click', openMonthPicker);
    $('#month-modal-close').addEventListener('click', closeMonthPicker);
    $('#month-modal').addEventListener('click', (e) => { if (e.target.id === 'month-modal') closeMonthPicker(); });

    // The chip names the problem; tapping it goes straight to the control that
    // fixes it, so noticing and correcting are one gesture.
    $('#topbar-month').addEventListener('click', () => {
      switchView('history');
      const el = $('#month-bar');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    // Two clocks, because either alone leaves a hole: the timer covers the app
    // being left open on a desk, `visibilitychange` covers it being closed or
    // backgrounded, where timers are throttled or never fire at all.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') maybeReturnToLiveMonth();
      else clearTimeout(historyIdleTimer);
    });
    window.addEventListener('focus', () => maybeReturnToLiveMonth());
  }

  function openMonthPicker() {
    renderMonthPicker();
    $('#month-modal').classList.remove('hidden');
  }

  function closeMonthPicker() {
    $('#month-modal').classList.add('hidden');
  }

  function renderMonthPicker() {
    const host = $('#month-picker-list');
    if (!host) return;
    const now = currentMonthKey();
    // Newest first — the thing you are most likely to want is under your thumb
    // and never behind a scroll.
    const months = [...state.availableMonths].reverse();

    let lastYear = null;
    const rows = months.map((m) => {
      const year = m.slice(0, 4);
      const head = year !== lastYear ? `<div class="month-picker-year">${escapeHtml(year)}</div>` : '';
      lastYear = year;
      const selected = m === state.activeMonth;
      const tag = m === now ? '<span class="month-picker-tag">This month</span>' : '';
      return `${head}
        <button type="button" class="month-picker-row${selected ? ' is-selected' : ''}" data-month-pick="${escapeHtml(m)}">
          <span class="month-picker-name">${escapeHtml(monthLabelLong(m))}</span>
          ${tag}
          ${selected ? '<svg class="icon-sm month-picker-check"><use href="#icon-check"/></svg>' : ''}
        </button>`;
    });

    host.innerHTML = rows.join('') || '<p class="panel-hint">No months yet.</p>';
    host.querySelectorAll('[data-month-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        closeMonthPicker();
        goToMonth(b.dataset.monthPick, { manual: true });
      })
    );
  }

  // =======================================================================
  // NAVIGATION
  // =======================================================================
  const VIEW_TITLES = { home: 'Home', analytics: 'Analytics', history: 'History', activity: 'Activity', profile: 'Profile' };
  // The views the month bar governs. Home is deliberately not one of them: it
  // is the live month and only the live month, so it never needs the chip and
  // can never be the screen someone misreads as "now".
  // Activity is not one either — the log is a single stream across all months,
  // so a month chip above it would be describing something it does not scope.
  const MONTH_SCOPED_VIEWS = ['analytics', 'history'];

  function initNav() {
    $$('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  function switchView(view) {
    closeAnySwipeRow();
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $('#topbar-title').textContent = VIEW_TITLES[view];
    $('#topbar-month').classList.toggle('hidden', !MONTH_SCOPED_VIEWS.includes(view));
    $('#fab-add').classList.toggle('hidden', view !== 'home');
    // Charts size themselves off their container, which has no width while
    // the view is display:none — so redraw once it's actually on screen.
    if (view === 'analytics') renderAnalytics();
  }

  // =======================================================================
  // HOME
  // =======================================================================
  // The headline figures come from /api/analytics, not from the visible
  // transaction list — the list is filtered, and "this month" must not move
  // when someone narrows the view to one person or one category.
  // Home is the live month and nothing else — there is no history state to
  // account for here, which is the whole point of moving the month control out.
  function renderHomeHero() {
    const a = state.homeAnalytics;
    if (!a || !a.thisMonth) return;
    const tm = a.thisMonth;

    $('#hero-month-label').textContent = 'This month';
    $('#summary-month-total').textContent = money(tm.total);
    renderHomeSharing(a);
    $('#home-avgday').textContent = money(tm.avgPerDay);
    $('#home-avgday-sub').textContent = 'so far';
    $('#home-delta').innerHTML = deltaHtml(a.momChange);
    $('#home-spark').innerHTML = sparklineSvg(a.monthly);
    state.txNoteMonth = monthLabelShort(tm.month);
    renderTxSectionNote();

    renderHomeBalance(a.settleUp);
    // Participation arrives with the analytics, and Profile is usually already
    // rendered by the time it does — so the card that displays it is redrawn
    // here rather than only from renderProfile, which runs first and would
    // leave it permanently empty.
    renderSharingCard();
  }

  // Who is sharing the bill this month, as a count and as faces.
  //
  // Home shows; Profile decides. This tile is deliberately inert — Home is a
  // glance at the live month, and the controls live in one place so there is
  // never a question of which screen is authoritative.
  //
  // "3 of 4" only appears when somebody is actually paused; a room where
  // everyone shares just reads "4", because the second number would be
  // explaining something that has not happened.
  function renderHomeSharing(a) {
    const facesEl = $('#home-sharing-faces');
    const subEl = $('#home-sharing-sub');
    if (!facesEl) return;
    const part = a.participation;
    const people = part
      ? part.members
      : state.members.map((m) => ({ memberId: m.id, name: m.name, avatar: m.avatar, statusNow: 'in' }));
    const total = people.length;
    const paused = people.filter((m) => m.statusNow !== 'in').length;

    // Sharing first, paused last and dimmed. Every face gets an equal slice of
    // the tile (see .hero-faces), so nothing ever overlaps.
    const ordered = [...people].sort((x, y) => (x.statusNow === y.statusNow ? 0 : x.statusNow === 'in' ? -1 : 1));
    facesEl.innerHTML = ordered
      .map((m) => `<span class="hero-face${m.statusNow !== 'in' ? ' is-paused' : ''}" title="${escapeHtml(m.name)}${m.statusNow !== 'in' ? ' — paused' : ''}">${avatarHtml(m.avatar, 'avatar-xs')}</span>`)
      .join('');
    facesEl.setAttribute('aria-label', paused ? `${total - paused} of ${total} sharing` : `${total} sharing`);
    if (subEl) subEl.textContent = !total ? '' : paused > 0 ? `${paused} paused` : total === 1 ? 'just you' : 'all sharing';
  }

  // Direction is carried by an arrow glyph and the sign as well as the
  // colour, so the chip still reads without colour vision.
  function deltaHtml(momChange) {
    if (momChange === null || momChange === undefined) return '';
    const up = momChange >= 0;
    const icon = up ? 'icon-trend-up' : 'icon-trend-down';
    return `<span class="delta ${up ? 'up' : 'down'}"><svg><use href="#${icon}"/></svg>${up ? '+' : '−'}${Math.abs(momChange)}% vs last month</span>`;
  }

  function renderHomeBalance(settle) {
    const valueEl = $('#summary-balance');
    const subEl = $('#summary-balance-sublabel');
    const mine = settle && settle.balances.find((b) => b.memberId === state.member.id);
    const bal = mine ? mine.balance : 0;
    const s = settle && settle.settlement;
    // A month everyone agreed is settled is square by definition — the debts
    // below were paid. Only while the agreement still covers the month though:
    // once spending has moved on (`stale`), the live balance is the truth
    // again and claiming £0.00 would be a lie.
    const agreedSettled = !!s && s.status === 'settled' && !s.stale;

    valueEl.classList.remove('is-pos', 'is-neg');
    if (mine && agreedSettled) {
      valueEl.textContent = money(0);
      subEl.textContent = 'settled up';
    } else if (!mine) {
      valueEl.textContent = '—';
      subEl.textContent = 'no spending yet';
    } else if (settle.totalSpend <= 0) {
      valueEl.textContent = '—';
      subEl.textContent = 'no spending yet';
    } else if (Math.abs(bal) < 0.005) {
      valueEl.textContent = money(0);
      subEl.textContent = 'settled up';
    } else if (bal > 0) {
      valueEl.textContent = `+${money(bal)}`;
      valueEl.classList.add('is-pos');
      subEl.textContent = "you're owed";
    } else {
      valueEl.textContent = `−${money(-bal)}`;
      valueEl.classList.add('is-neg');
      subEl.textContent = 'you owe';
    }
  }

  // ---------------------------------------------------------------------
  // Transaction rows
  //
  // Every row is the same height, whatever it holds. A list where the cards
  // breathe in and out with the length of a description reads as noise, and
  // the eye loses the column of amounts. So: one line of description, one line
  // of metadata, both clipped, and a fixed box — nothing in the data can
  // change the geometry.
  // ---------------------------------------------------------------------
  // One transaction, as a summary you can open.
  //
  // Two earlier shapes bracket this one. A labelled 2x2 fact grid showed
  // everything but cost ~175px a card. Collapsing it onto a single meta line
  // got that to ~66px, but bought the space from the wrong places: the
  // description clipped mid-word, and on a narrow phone the meta line
  // overflowed and the place — the only item allowed to shrink — disappeared
  // entirely.
  //
  // So the card stops trying to hold everything. It carries what you scan for
  // (what, how much, when, which category, who paid) and is a button, because
  // the rest is one tap away in the detail sheet. Moving edit and delete into
  // that sheet is what pays for the description having two full lines: the
  // 62px the two buttons held is now the widest part of the card.
  //
  // Both lines are reserved whether or not they are filled, so every card is
  // still exactly the same height.
  function txItemNode(e) {
    const locked = !monthIsWritable(e.date.slice(0, 7));
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tx-card' + (locked ? ' is-locked' : '');
    item.dataset.id = e.id;
    item.setAttribute('aria-label', `${e.description}, ${money(e.amount)}. Open details.`);

    item.innerHTML = `
        ${catIconHtml(e.category, 'tx-icon')}
        <span class="tx-desc">${escapeHtml(e.description)}</span>
        <span class="tx-amount">${money(e.amount)}</span>
        <span class="tx-meta">
          <span class="tx-meta-item">${escapeHtml(dayHeadingLabel(e.date))}</span>
          <span class="tx-meta-item">${escapeHtml(e.category)}</span>
          <span class="tx-meta-item tx-meta-payer">${avatarHtml(e.paidBy.avatar, 'avatar-xs')}<span>${escapeHtml(e.paidBy.name)}</span></span>
        </span>
        ${locked ? `<span class="tx-lock" title="${escapeHtml(monthLabelLong(e.date.slice(0, 7)))} is closed"><svg class="icon-sm"><use href="#icon-lock"/></svg></span>` : ''}`;
    return item;
  }

  // ---- swipe to reveal edit and delete ----------------------------------
  //
  // History rows carry the two actions behind the card; you pull the card left
  // to uncover them. Tapping still opens the detail sheet, which is now purely
  // a reader — it is the only place the full description, the exact date and
  // the place are guaranteed to be legible, so tap could not simply go inert.
  //
  // Home never gets this. Home is a glance at the live month and is read only
  // by design, so fillTxList only binds the swipe where it was asked for.
  //
  // Pointer Events rather than touch events: the same code then covers a mouse
  // drag on desktop, where there is no touch to swipe with.
  const SWIPE_REVEAL = 104;   // px — two round buttons plus their gaps (.tx-swipe-actions)
  const SWIPE_SLOP = 8;       // px of travel before we decide this is a swipe
  let openSwipeRow = null;

  function closeSwipeRow(row) {
    if (!row) return;
    row.classList.remove('is-open');
    const card = row.querySelector('.tx-card');
    if (card) card.style.transform = '';
    row.querySelectorAll('.tx-swipe-btn').forEach((b) => b.setAttribute('tabindex', '-1'));
    if (openSwipeRow === row) openSwipeRow = null;
  }

  function closeAnySwipeRow() {
    closeSwipeRow(openSwipeRow);
  }

  function openSwipeRowEl(row) {
    if (openSwipeRow && openSwipeRow !== row) closeSwipeRow(openSwipeRow);
    row.classList.add('is-open');
    const card = row.querySelector('.tx-card');
    if (card) card.style.transform = `translateX(-${SWIPE_REVEAL}px)`;
    row.querySelectorAll('.tx-swipe-btn').forEach((b) => b.setAttribute('tabindex', '0'));
    openSwipeRow = row;
  }

  // A locked month has nothing to reveal, so its rows are plain cards.
  function swipeRowNode(e) {
    const card = txItemNode(e);
    const row = document.createElement('div');
    row.className = 'tx-row';
    row.dataset.id = e.id;

    if (card.classList.contains('is-locked')) {
      row.appendChild(card);
      return row;
    }

    const actions = document.createElement('div');
    actions.className = 'tx-swipe-actions';
    actions.innerHTML = `
        <button type="button" class="tx-swipe-btn tx-swipe-edit" data-action="edit" tabindex="-1"
                aria-label="Edit ${escapeHtml(e.description)}" title="Edit"><svg class="icon-sm"><use href="#icon-edit"/></svg></button>
        <button type="button" class="tx-swipe-btn tx-swipe-del" data-action="delete" tabindex="-1"
                aria-label="Delete ${escapeHtml(e.description)}" title="Delete"><svg class="icon-sm"><use href="#icon-trash"/></svg></button>`;
    row.appendChild(actions);
    row.appendChild(card);

    actions.querySelector('[data-action="edit"]').addEventListener('click', () => {
      closeSwipeRow(row); openExpenseModal(e.id);
    });
    actions.querySelector('[data-action="delete"]').addEventListener('click', () => {
      closeSwipeRow(row); confirmDeleteExpense(e.id);
    });

    bindSwipe(row, card);
    return row;
  }

  function bindSwipe(row, card) {
    let startX = 0, startY = 0, startOffset = 0;
    let axis = null;       // null until the gesture commits to 'x' or 'y'
    let dragged = false;   // set once we move on x, so the click is suppressed

    card.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      startX = ev.clientX; startY = ev.clientY;
      startOffset = row.classList.contains('is-open') ? -SWIPE_REVEAL : 0;
      axis = null; dragged = false;
      card.classList.add('is-dragging');
    });

    card.addEventListener('pointermove', (ev) => {
      if (!card.classList.contains('is-dragging')) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      // Decide once. A vertical gesture is the page scrolling and must be left
      // alone; claiming it would make the list feel stuck.
      if (axis === null) {
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') { card.classList.remove('is-dragging'); return; }
        card.setPointerCapture(ev.pointerId);
        row.classList.add('is-swiping');
      }

      dragged = true;
      const offset = Math.max(-SWIPE_REVEAL, Math.min(0, startOffset + dx));
      card.style.transform = `translateX(${offset}px)`;
    });

    const finish = (ev) => {
      if (!card.classList.contains('is-dragging')) return;
      card.classList.remove('is-dragging');
      row.classList.remove('is-swiping');
      if (card.hasPointerCapture && card.hasPointerCapture(ev.pointerId)) card.releasePointerCapture(ev.pointerId);
      if (axis !== 'x') return;
      const dx = ev.clientX - startX;
      const offset = Math.max(-SWIPE_REVEAL, Math.min(0, startOffset + dx));
      if (offset < -SWIPE_REVEAL / 2) openSwipeRowEl(row); else closeSwipeRow(row);
    };
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);

    // A drag must not also read as a tap, and a tap on an open row closes it
    // rather than opening the sheet on top of the revealed buttons.
    card.addEventListener('click', (ev) => {
      if (dragged) { ev.preventDefault(); ev.stopPropagation(); dragged = false; return; }
      if (row.classList.contains('is-open')) { ev.preventDefault(); ev.stopPropagation(); closeSwipeRow(row); }
    }, true);

    // There is no swipe on a keyboard, so give the same two actions a key.
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault(); openSwipeRowEl(row);
        const first = row.querySelector('.tx-swipe-btn');
        if (first) first.focus();
      } else if (ev.key === 'ArrowRight' || ev.key === 'Escape') {
        ev.preventDefault(); closeSwipeRow(row);
      }
    });
    row.querySelectorAll('.tx-swipe-btn').forEach((b) =>
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'ArrowRight') { ev.preventDefault(); closeSwipeRow(row); card.focus(); }
      })
    );
  }

  // Home and Activity both render through fillTxList, so a row can come from
  // either list. Look in both rather than assuming which view asked.
  function findExpense(id) {
    return (state.expenses || []).find((x) => x.id === id)
        || (state.historyExpenses || []).find((x) => x.id === id)
        || null;
  }

  // The detail sheet: everything the card had to leave out, and the two
  // actions. Built fresh on open so it can never show a stale row.
  function openTxDetail(id) {
    const e = findExpense(id);
    if (!e) return;
    const locked = !monthIsWritable(e.date.slice(0, 7));

    $('#tx-detail-head').innerHTML = `
        ${catIconHtml(e.category, 'tx-icon')}
        <div class="txd-headline">
          <h3 class="txd-desc">${escapeHtml(e.description)}</h3>
          <div class="txd-amount">${money(e.amount)}</div>
        </div>`;

    const row = (label, valueHtml) =>
      `<div class="txd-fact"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;

    $('#tx-detail-facts').innerHTML = [
      // absDate() is for SQLite datetimes: it appends a 'Z'. e.date is a plain
      // YYYY-MM-DD, and "2026-08-19Z" is not a form Safari/iOS will parse, so
      // this rendered "Invalid Date" on every phone. Days have their own
      // formatter — use it.
      row('Date', escapeHtml(formatDateLabel(e.date))),
      row('Category', escapeHtml(e.category)),
      row('Paid by', `${avatarHtml(e.paidBy.avatar, 'avatar-xs')}<span>${escapeHtml(e.paidBy.name)}</span>`),
      row('Place', e.location ? escapeHtml(e.location) : '<span class="txd-empty">Not recorded</span>'),
    ].join('');

    // The sheet reads; it no longer acts. Edit and delete moved onto the swipe,
    // so what is left here is where to find them — and, for a closed month,
    // why there is nothing to find.
    $('#tx-detail-actions').innerHTML = locked
      ? `<p class="txd-locked"><svg class="icon-sm"><use href="#icon-lock"/></svg><span>${escapeHtml(monthLabelLong(e.date.slice(0, 7)))} is closed — entries can no longer be changed.</span></p>`
      : '';

    $('#tx-detail-modal').classList.remove('hidden');
  }

  function closeTxDetail() {
    $('#tx-detail-modal').classList.add('hidden');
  }

  function initTxDetail() {
    document.addEventListener('pointerdown', (ev) => {
      if (openSwipeRow && !openSwipeRow.contains(ev.target)) closeAnySwipeRow();
    }, true);
    $('#tx-detail-close').addEventListener('click', closeTxDetail);
    // Tapping the dimmed ground closes it; tapping the sheet itself must not.
    $('#tx-detail-modal').addEventListener('click', (ev) => {
      if (ev.target === $('#tx-detail-modal')) closeTxDetail();
    });
  }

  function fillTxList(listEl, rows, opts) {
    const swipe = !!(opts && opts.swipe);
    if (openSwipeRow && listEl.contains(openSwipeRow)) closeAnySwipeRow();
    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of rows) frag.appendChild(swipe ? swipeRowNode(e) : txItemNode(e));
    listEl.appendChild(frag);

    // The card opens the reader on both lists. On a swipe list the capture
    // handler in bindSwipe gets first refusal, so a drag or an open row never
    // reaches this.
    listEl.querySelectorAll('.tx-card').forEach((c) =>
      c.addEventListener('click', () => openTxDetail(Number(c.dataset.id)))
    );
  }

  // Home is a glance, not a ledger: the newest few only, with the full month
  // one tap away in Activity. The API already returns newest-first
  // (ORDER BY created_at DESC, id DESC), so this slice really is the most
  // recent ten rather than an arbitrary ten.
  const RECENT_LIMIT = 10;

  // Both the analytics render and this one have half of the section note to
  // write, and their requests race. So each puts its half in state and calls
  // this, and neither can wipe the other's.
  function renderTxSectionNote() {
    const el = $('#tx-section-note');
    if (!el) return;
    const parts = [];
    if (state.txNoteMonth) parts.push(state.txNoteMonth);
    if (state.txTotalCount) parts.push(`${RECENT_LIMIT} of ${state.txTotalCount}`);
    el.textContent = parts.join(' \u00b7 ');
  }

  // Home: the live month, narrowed by whatever search and filters are set.
  function renderTransactions() {
    const all = state.expenses;
    fillTxList($('#tx-list'), all.slice(0, RECENT_LIMIT));
    $('#tx-empty').classList.toggle('hidden', all.length > 0);
    $('#tx-empty-text').textContent = 'No transactions yet. Tap + to add one.';
    // Only worth saying when something is actually being held back.
    state.txTotalCount = all.length > RECENT_LIMIT ? all.length : 0;
    renderTxSectionNote();
  }

  // History: the whole of whichever month the bar is on, unfiltered.
  //
  // Everything here is named after the month the rows themselves came from, not
  // after state.isCurrentMonth — that flag is set by the analytics request, and
  // the two requests race, so reading it here can caption June's rows "This
  // month" for as long as the mismatch survives.
  function renderHistoryTransactions() {
    const list = $('#history-tx-list');
    if (!list) return;
    fillTxList(list, state.historyExpenses, { swipe: true });

    const rows = state.historyExpenses;
    const month = state.historyMonth || state.activeMonth || currentMonthKey();
    const isLive = month === currentMonthKey();
    const total = rows.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const label = $('#month-summary-label');
    const totalEl = $('#month-summary-total');
    const countEl = $('#month-summary-count');
    if (label) label.textContent = isLive ? 'This month' : monthLabelLong(month);
    if (totalEl) totalEl.textContent = money(total);
    const filtered = isFiltered();
    if (label && filtered) label.textContent = `${isLive ? 'This month' : monthLabelLong(month)} · matching`;
    if (countEl) countEl.textContent = rows.length === 1 ? `1 ${filtered ? 'match' : 'transaction'}` : `${rows.length} ${filtered ? 'matches' : 'transactions'}`;
    $('#history-tx-empty').classList.toggle('hidden', rows.length > 0);
    $('#history-tx-empty-text').textContent = filtered
      ? `Nothing in ${isLive ? 'this month' : monthLabelLong(month)} matches your search.`
      : isLive
        ? 'Nothing recorded this month yet.'
        : `Nothing was recorded in ${monthLabelLong(month)}.`;
  }

  function populateFilterOptions() {
    const memberSel = $('#filter-member');
    memberSel.innerHTML = '<option value="">Everyone</option>' +
      state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    memberSel.value = state.filters.member;

    const catSel = $('#filter-category');
    catSel.innerHTML = '<option value="">All categories</option>' +
      state.categoryGroups.map((g) => `<optgroup label="${escapeHtml(g.name)}">${g.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>`).join('');
    catSel.value = state.filters.category;
  }

  // The month is deliberately not counted here — it's always set, so counting
  // it would leave the filter button permanently lit.
  function updateFilterIndicator() {
    const f = state.filters;
    const active = !!(f.member || f.category);
    $('#filter-toggle-btn').classList.toggle('on', active);
  }

  function initFilters() {
    $('#filter-toggle-btn').addEventListener('click', () => $('#filter-panel').classList.toggle('hidden'));

    let searchDebounce;
    $('#search-input').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.filters.q = e.target.value.trim();
        refreshHistoryExpenses();
      }, 300);
    });

    $('#filter-member').addEventListener('change', (e) => { state.filters.member = e.target.value; updateFilterIndicator(); refreshHistoryExpenses(); });
    $('#filter-category').addEventListener('change', (e) => { state.filters.category = e.target.value; updateFilterIndicator(); refreshHistoryExpenses(); });
    $('#filter-clear-btn').addEventListener('click', () => {
      state.filters = { member: '', category: '', q: '' };
      $('#search-input').value = '';
      populateFilterOptions();
      updateFilterIndicator();
      refreshHistoryExpenses();
    });
  }

  // =======================================================================
  // EXPENSE MODAL
  // =======================================================================
  const PRODUCT_PRESETS = {
    'Groceries': [
      { label: 'Milk', icon: 'prod-milk' }, { label: 'Vegetables', icon: 'prod-veg' },
      { label: 'Fruit', icon: 'prod-fruit' }, { label: 'Meat', icon: 'prod-meat' },
      { label: 'Chicken', icon: 'prod-chicken' }, { label: 'Fish', icon: 'prod-fish' },
      { label: 'Bread', icon: 'prod-bread' }, { label: 'Eggs', icon: 'prod-eggs' },
      { label: 'Cheese', icon: 'prod-cheese' }, { label: 'Butter', icon: 'prod-butter' },
      { label: 'Yogurt', icon: 'prod-yogurt' }, { label: 'Honey', icon: 'prod-honey' },
      { label: 'Cooking Oil', icon: 'prod-oil' }, { label: 'Sauces', icon: 'prod-sauce' },
      { label: 'Sugar', icon: 'prod-sugar' }, { label: 'Flour', icon: 'prod-flour' },
      { label: 'Rice', icon: 'prod-rice' }, { label: 'Pasta', icon: 'prod-pasta' },
      { label: 'Cereal', icon: 'prod-cereal' }, { label: 'Spices', icon: 'prod-spices' },
      { label: 'Nuts', icon: 'prod-nuts' }, { label: 'Snacks', icon: 'prod-snacks' },
      { label: 'Chocolate', icon: 'prod-chocolate' }, { label: 'Ice Cream', icon: 'prod-icecream' },
      { label: 'Drinks', icon: 'prod-drinks' }, { label: 'Juice', icon: 'prod-juice' },
      { label: 'Water', icon: 'prod-water' }, { label: 'Coffee', icon: 'prod-coffee' },
      { label: 'Tea', icon: 'prod-tea' }, { label: 'Frozen Food', icon: 'prod-frozen' },
      { label: 'Canned Goods', icon: 'prod-canned' }, { label: 'Cleaning', icon: 'prod-cleaning' },
      { label: 'Toiletries', icon: 'prod-toiletries' }, { label: 'Paper Goods', icon: 'prod-paper' },
      { label: 'Baby Food', icon: 'prod-babyfood' }, { label: 'Pet Food', icon: 'prod-petfood' },
    ],
    'Eating Out': [
      { label: 'Restaurant', icon: 'cat-eatingout' }, { label: 'Takeaway', icon: 'cat-shopping' },
      { label: 'Coffee', icon: 'prod-coffee' }, { label: 'Fast Food', icon: 'prod-fastfood' },
      { label: 'Ice Cream', icon: 'prod-icecream' }, { label: 'Drinks', icon: 'cat-nightlife' },
    ],
    'Shopping': [
      { label: 'Clothing', icon: 'prod-clothing' }, { label: 'Electronics', icon: 'prod-electronics' },
      { label: 'Gifts', icon: 'prod-gifts' }, { label: 'Homeware', icon: 'cat-furniture' },
      { label: 'Books', icon: 'cat-books' }, { label: 'Hardware', icon: 'cat-hardware' },
    ],
    'Transport': [
      { label: 'Taxi', icon: 'cat-taxi' }, { label: 'Bus / Train', icon: 'cat-transit' },
      { label: 'Fuel', icon: 'cat-fuel' }, { label: 'Parking', icon: 'cat-parking' },
    ],
    'Health': [
      { label: 'Pharmacy', icon: 'cat-health' }, { label: 'Toiletries', icon: 'prod-toiletries' },
      { label: 'Gym', icon: 'cat-gym' }, { label: 'Haircut', icon: 'cat-haircut' },
    ],
    'Entertainment': [
      { label: 'Cinema', icon: 'cat-entertainment' }, { label: 'Games', icon: 'cat-gaming' },
      { label: 'Music', icon: 'cat-music' }, { label: 'Sports', icon: 'cat-sports' },
      { label: 'Night Out', icon: 'cat-nightlife' }, { label: 'Travel', icon: 'cat-travel' },
    ],
  };
  const TINT_CYCLE = ['ocean', 'mint', 'sunset', 'berry', 'grape', 'citrus', 'coral', 'indigo', 'rose', 'teal', 'amber', 'violet'];

  function buildCategoryGrid() {
    const grid = $('#expense-category-grid');
    grid.innerHTML = state.categoryGroups
      .map((g) => `
        <div class="group-title">${escapeHtml(g.name)}</div>
        ${g.categories
          .map((c) => `
            <button type="button" class="category-chip tint-${c.color}" data-category="${escapeHtml(c.name)}">
              ${catIconHtml(c.name, 'cat-icon-wrap')}
              <span>${escapeHtml(c.name)}</span>
            </button>`)
          .join('')}`)
      .join('');
    grid.querySelectorAll('.category-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        grid.querySelectorAll('.category-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        $('#expense-category').value = chip.dataset.category;
        renderProductPicker(chip.dataset.category);
      });
    });
  }

  function renderProductPicker(category, selectedLabels = []) {
    const wrap = $('#expense-product-picker');
    const products = PRODUCT_PRESETS[category];
    if (!products || !products.length) {
      wrap.classList.add('hidden');
      return;
    }
    $('#expense-product-title').textContent = `${category} — tap to pick (multiple allowed)`;
    const grid = $('#expense-product-grid');
    const selectedSet = new Set(selectedLabels.map((s) => s.toLowerCase()));
    grid.innerHTML = products
      .map((p, i) => `
        <button type="button" class="product-chip tint-${TINT_CYCLE[i % TINT_CYCLE.length]}${selectedSet.has(p.label.toLowerCase()) ? ' selected' : ''}" data-label="${escapeHtml(p.label)}">
          <span class="prod-icon-wrap"><svg><use href="#${p.icon}"/></svg></span>
          <span>${escapeHtml(p.label)}</span>
        </button>`)
      .join('');
    grid.querySelectorAll('.product-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        syncDescriptionFromProductChips();
      });
    });
    wrap.classList.remove('hidden');
  }

  function syncDescriptionFromProductChips() {
    const grid = $('#expense-product-grid');
    const labels = Array.from(grid.querySelectorAll('.product-chip.selected')).map((c) => c.dataset.label);
    $('#expense-description').value = labels.join(', ');
  }

  // =======================================================================
  // CHANGE YOUR NAME
  //
  // The name is both a label and a login handle, so the server enforces the
  // same per-room uniqueness the join path does and answers 409 on a clash.
  // Nothing historical is rewritten — expenses point at member ids, so old
  // entries simply start showing the new name.
  // =======================================================================
  function openNameModal() {
    $('#name-error').textContent = '';
    $('#name-input').value = state.member ? state.member.name : '';
    $('#name-modal').classList.remove('hidden');
    $('#name-input').focus();
    $('#name-input').select();
  }

  function closeNameModal() {
    $('#name-modal').classList.add('hidden');
  }

  function initNameModal() {
    $('#profile-name-edit').addEventListener('click', openNameModal);
    $('#name-modal-close').addEventListener('click', closeNameModal);
    $('#name-modal').addEventListener('click', (ev) => {
      if (ev.target === $('#name-modal')) closeNameModal();
    });

    $('#name-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#name-error');
      errEl.textContent = '';

      const name = $('#name-input').value.trim();
      if (!name) { errEl.textContent = 'Please enter a name'; return; }
      if (state.member && name === state.member.name) { closeNameModal(); return; }

      const btn = $('#name-form').querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const member = await api('/api/member/name', {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        state.member.name = member.name;
        closeNameModal();
        // The socket refreshes everyone else; do our own so the change is
        // visible immediately even if the socket is down.
        await Promise.all([refreshMembers(), refreshExpenses(), refreshHistoryExpenses(), refreshActivity()]);
        populateFilterOptions();
        renderProfile();
        toast('Your name was changed');
      } catch (err) {
        errEl.textContent = err.message || 'Could not change your name';
      } finally {
        btn.disabled = false;
      }
    });
  }

  function openExpenseModal(expenseId) {
    state.editingExpenseId = expenseId || null;
    const form = $('#expense-form');
    form.reset();
    $('#expense-category-grid').querySelectorAll('.category-chip').forEach((c) => c.classList.remove('selected'));
    $('#expense-product-picker').classList.add('hidden');

    if (expenseId) {
      // findExpense, not state.expenses: a row opened from History lives in
      // state.historyExpenses, and looking in only one list made Edit a no-op
      // for every History row.
      const e = findExpense(expenseId);
      if (!e) return;
      $('#expense-modal-title').textContent = 'Edit expense';
      $('#expense-id').value = e.id;
      $('#expense-description').value = e.description;
      $('#expense-amount').value = e.amount;
      $('#expense-location').value = e.location || '';
      $('#expense-date').value = e.date;
      $('#expense-date-label').textContent = formatDateLabel(e.date);
      $('#expense-category').value = e.category;
      const chip = $('#expense-category-grid').querySelector(`[data-category="${CSS.escape(e.category)}"]`);
      if (chip) chip.classList.add('selected');
      renderProductPicker(e.category, e.description.split(',').map((s) => s.trim()));
    } else {
      $('#expense-modal-title').textContent = 'Add expense';
      $('#expense-id').value = '';
      $('#expense-location').value = '';
      const todayIso = new Date().toISOString().slice(0, 10);
      $('#expense-date').value = todayIso;
      $('#expense-date-label').textContent = formatDateLabel(todayIso);
      $('#expense-category').value = '';
    }
    updateExpenseMonthNotice();
    updateExpenseDateHint();
    $('#expense-modal').classList.remove('hidden');
    setTimeout(() => $('#expense-amount').focus(), 50);
  }

  function closeExpenseModal() {
    $('#expense-modal').classList.add('hidden');
    state.editingExpenseId = null;
  }

  // Which month this entry will actually land in. The *date* decides that, and
  // that is exactly the thing people get wrong — so it is stated on the form
  // whenever the entry is not dated in the live month.
  function updateExpenseMonthNotice() {
    const el = $('#expense-month-notice');
    if (!el) return;
    const landsIn = ($('#expense-date').value || '').slice(0, 7);
    const now = currentMonthKey();
    if (!landsIn || landsIn === now) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.innerHTML = `Recorded in <strong>${escapeHtml(monthLabelLong(landsIn))}</strong> — not the current month.`;
    el.classList.remove('hidden');
  }

  // The window, in the same words the server would use to refuse. Shown before
  // the picker opens, so nobody discovers the rule by being rejected by it.
  function updateExpenseDateHint() {
    const el = $('#expense-date-hint');
    if (!el) return;
    const w = writeWindow();
    if (w.graceMonth) {
      el.innerHTML = `You can still add to <strong>${escapeHtml(monthLabelLong(w.graceMonth))}</strong> until ${escapeHtml(formatDateLabel(w.graceEndsOn))}. Nothing can be dated in the future.`;
    } else {
      el.innerHTML = `Only <strong>${escapeHtml(monthLabelLong(w.currentMonth))}</strong> is open for entry — earlier months closed ${w.graceDays} days after they ended. Nothing can be dated in the future.`;
    }
  }

  // Home is always the live month now, so there is no wrong-month trap left to
  // warn about: the FAB, the list under it and the date default all agree.
  function startAddExpense() {
    openExpenseModal(null);
  }

  function initExpenseModal() {
    $('#fab-add').addEventListener('click', () => startAddExpense());
    $('#expense-modal-close').addEventListener('click', closeExpenseModal);
    $('#expense-modal').addEventListener('click', (e) => { if (e.target.id === 'expense-modal') closeExpenseModal(); });

    $('#expense-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const category = $('#expense-category').value;
      if (!category) { toast('Please choose a category'); return; }

      const payload = {
        description: $('#expense-description').value.trim(),
        amount: Number($('#expense-amount').value),
        date: $('#expense-date').value,
        location: $('#expense-location').value.trim(),
        category,
      };
      const id = $('#expense-id').value;

      try {
        if (id) {
          await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          toast('Expense updated');
        } else {
          await api('/api/expenses', { method: 'POST', body: JSON.stringify(payload) });
          toast('Expense added');
        }
        closeExpenseModal();

        // An entry dated into the grace month lands in last month's history,
        // not on Home. Follow it there, so saving and then not seeing it can
        // never read as the save having failed.
        const savedMonth = (payload.date || '').slice(0, 7);
        if (savedMonth && savedMonth !== currentMonthKey() && savedMonth !== state.activeMonth) {
          state.activeMonth = savedMonth;
          state.monthTouchedAt = Date.now();
          switchView('history');
          toast(`Saved into ${monthLabelLong(savedMonth)} — shown here in History`);
        }

        await refreshAll();
      } catch (err) {
        toast(err.message);
      }
    });

    $('#expense-date-btn').addEventListener('click', () => openDatePicker('expense-date', 'expense-date-label', { clamped: true }));
  }

  // ---------------------------------------------------------------------
  // Custom calendar date picker
  // ---------------------------------------------------------------------
  let calendarViewDate = new Date();
  let calendarSelectedIso = null;
  let calendarTargetInputId = null;
  let calendarLabelElId = null;
  // Only the expense form is bound by the write window; any other date field
  // that reuses this picker later should stay unclamped by default.
  let calendarClamped = false;

  function openDatePicker(hiddenInputId, labelElId, { clamped = false } = {}) {
    calendarTargetInputId = hiddenInputId;
    calendarLabelElId = labelElId;
    calendarClamped = clamped;
    const current = $(`#${hiddenInputId}`).value;
    calendarViewDate = current ? new Date(current + 'T00:00:00') : new Date();
    calendarSelectedIso = current || null;
    renderCalendar();
    $('#date-modal').classList.remove('hidden');
  }

  // The calendar only ever offers days inside the write window: closed months
  // and the future are drawn but dead, so the shape of the rule is visible
  // rather than being discovered through an error message.
  function renderCalendar() {
    const y = calendarViewDate.getFullYear();
    const m = calendarViewDate.getMonth();
    $('#date-month-label').textContent = calendarViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const w = writeWindow();
    const todayIso = w.today;
    const viewMonth = `${y}-${String(m + 1).padStart(2, '0')}`;

    let cells = '';
    for (let i = 0; i < firstWeekday; i++) cells += `<span></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const classes = ['date-cell'];
      if (iso === todayIso) classes.push('today');
      if (iso === calendarSelectedIso) classes.push('selected');
      const usable = calendarClamped ? dateIsWritable(iso) : true;
      if (!usable) classes.push('out-of-range');
      cells += `<button type="button" class="${classes.join(' ')}" data-iso="${iso}"${usable ? '' : ' disabled'}>${d}</button>`;
    }
    $('#date-grid').innerHTML = cells;
    $('#date-grid').querySelectorAll('.date-cell').forEach((btn) => {
      btn.addEventListener('click', () => selectDate(btn.dataset.iso));
    });

    // Paging out of the window is the same dead end as tapping a dead day.
    if (calendarClamped) {
      $('#date-prev-month').disabled = viewMonth <= w.months[0];
      $('#date-next-month').disabled = viewMonth >= w.currentMonth;
    } else {
      $('#date-prev-month').disabled = false;
      $('#date-next-month').disabled = false;
    }
  }

  function selectDate(iso) {
    calendarSelectedIso = iso;
    $(`#${calendarTargetInputId}`).value = iso;
    $(`#${calendarLabelElId}`).textContent = formatDateLabel(iso);
    $('#date-modal').classList.add('hidden');
    // The picked date is what decides the month an expense lands in, so the
    // notice has to move with it, not just with the modal opening.
    if (calendarTargetInputId === 'expense-date') updateExpenseMonthNotice();
  }

  function initDatePicker() {
    $('#date-modal-close').addEventListener('click', () => $('#date-modal').classList.add('hidden'));
    $('#date-modal').addEventListener('click', (e) => { if (e.target.id === 'date-modal') $('#date-modal').classList.add('hidden'); });
    $('#date-prev-month').addEventListener('click', () => {
      calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
      renderCalendar();
    });
    $('#date-next-month').addEventListener('click', () => {
      calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
      renderCalendar();
    });
    $('#date-today-btn').addEventListener('click', () => {
      calendarViewDate = new Date();
      selectDate(new Date().toISOString().slice(0, 10));
    });
  }

  // ---------------------------------------------------------------------
  // Confirmation modal
  // ---------------------------------------------------------------------
  let pendingConfirmAction = null;
  let pendingAltAction = null;

  // `altLabel` adds a third choice for the cases where "cancel or confirm" is
  // a false pair — a warning where carrying on is legitimate, not a mistake.
  function openConfirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true, onConfirm, altLabel, onAlt }) {
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = confirmLabel;
    okBtn.className = danger ? 'btn-danger' : 'btn-primary';
    $('#confirm-cancel').textContent = cancelLabel;

    const altBtn = $('#confirm-alt');
    altBtn.classList.toggle('hidden', !altLabel);
    if (altLabel) altBtn.textContent = altLabel;
    $('#confirm-actions').classList.toggle('stacked', !!altLabel);

    pendingConfirmAction = onConfirm;
    pendingAltAction = altLabel ? onAlt : null;
    $('#confirm-modal').classList.remove('hidden');
  }

  function confirmDeleteExpense(id) {
    // Same as openExpenseModal: History rows are not in state.expenses.
    const e = findExpense(id);
    if (!e) return;
    openConfirm({
      title: 'Delete this expense?',
      body: `"${e.description}" (${money(e.amount)}) will be permanently removed from everyone's history and from this month's split. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api(`/api/expenses/${id}`, { method: 'DELETE' });
        toast('Expense deleted');
        await refreshAll();
      },
    });
  }

  function initConfirmModal() {
    // Every path clears *both* pending actions, so a dialog can never leave a
    // stale handler armed for the next one that opens.
    const runAndClose = async (which) => {
      const action = which === 'alt' ? pendingAltAction : pendingConfirmAction;
      pendingConfirmAction = null;
      pendingAltAction = null;
      $('#confirm-modal').classList.add('hidden');
      if (!action) return;
      try {
        await action();
      } catch (err) {
        toast(err.message);
      }
    };

    $('#confirm-cancel').addEventListener('click', () => {
      $('#confirm-modal').classList.add('hidden');
      pendingConfirmAction = null;
      pendingAltAction = null;
    });
    $('#confirm-ok').addEventListener('click', () => runAndClose('ok'));
    $('#confirm-alt').addEventListener('click', () => runAndClose('alt'));
  }

  // =======================================================================
  // ANALYTICS
  //
  // Every chart here encodes magnitude in a single hue. Identity is carried
  // by the tinted glyph and the text label on each row — never by the fill,
  // because a twelve-step chalk palette cannot be told apart under any
  // colour-vision deficiency (worst adjacent pair separates by ΔE 2.1).
  // =======================================================================

  function svgEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Sparkline: six months, no axes. Context, not a readable scale. -----
  function sparklineSvg(monthly) {
    if (!monthly || monthly.length < 2) return '';
    const W = 300, H = 34, pad = 2;
    const max = Math.max(1, ...monthly.map((m) => m.total));
    const step = (W - pad * 2) / (monthly.length - 1);
    const pts = monthly.map((m, i) => ({
      x: pad + step * i,
      y: pad + (1 - m.total / max) * (H - pad * 2 - 3),
    }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H} L${pts[0].x.toFixed(1)},${H} Z`;
    const last = pts[pts.length - 1];
    return `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" role="img"
           aria-label="Six-month spending trend, ending at ${money(monthly[monthly.length - 1].total)}">
        <path d="${area}" class="chart-area"/>
        <path d="${line}" class="chart-line" vector-effect="non-scaling-stroke"/>
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" class="chart-dot"/>
      </svg>`;
  }

  // --- Monthly trend: line + area, gridlines, hover readout --------------
  function renderTrendChart(monthly) {
    const host = $('#monthly-trend');
    if (!monthly || !monthly.length) {
      host.innerHTML = `<p class="chart-empty">No history yet.</p>`;
      return;
    }
    if (monthly.length === 1) {
      host.innerHTML = `<p class="chart-empty">${escapeHtml(monthLabelLong(monthly[0].month))} — ${money(monthly[0].total)}. A second month of data will draw the trend.</p>`;
      return;
    }

    const W = 320, H = 150, padL = 30, padR = 8, padT = 14, padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const max = Math.max(1, ...monthly.map((m) => m.total));
    const step = innerW / (monthly.length - 1);

    const pts = monthly.map((m, i) => ({
      x: padL + step * i,
      y: padT + (1 - m.total / max) * innerH,
      m,
    }));

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${padT + innerH} L${pts[0].x.toFixed(1)},${padT + innerH} Z`;

    // Three gridlines is enough to read a level off; more is noise.
    const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, y: padT + (1 - f) * innerH }));
    const grid = ticks
      .map((t) => `<line x1="${padL}" y1="${t.y.toFixed(1)}" x2="${W - padR}" y2="${t.y.toFixed(1)}" class="chart-grid"/>
                   <text x="${padL - 6}" y="${(t.y + 3).toFixed(1)}" text-anchor="end" class="chart-axis">${svgEsc(moneyShort(t.v))}</text>`)
      .join('');

    const dots = pts
      .map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === pts.length - 1 ? 3.6 : 2.8}" class="chart-dot"/>`)
      .join('');

    const xLabels = pts
      .map((p) => `<text x="${p.x.toFixed(1)}" y="${H - 5}" text-anchor="middle" class="chart-axis">${svgEsc(monthLabel(p.m.month))}</text>`)
      .join('');

    const hits = pts
      .map((p, i) => `<rect x="${(p.x - step / 2).toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${innerH}" class="chart-hit" data-i="${i}"/>`)
      .join('');

    host.innerHTML = `
      <div class="chart-host">
        <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Monthly spending trend">
          ${grid}
          <path d="${area}" class="chart-area"/>
          <path d="${line}" class="chart-line"/>
          ${dots}
          ${xLabels}
          <line class="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}" style="display:none"/>
          ${hits}
        </svg>
        <div class="chart-tip" hidden></div>
      </div>`;

    attachChartHover(host, pts.map((p) => ({
      x: p.x, y: p.y, W,
      title: monthLabelLong(p.m.month),
      value: money(p.m.total),
    })));
  }

  // --- Day-by-day bars for the current month ----------------------------
  function renderDailyChart(tm) {
    const host = $('#daily-chart');
    const note = $('#daily-note');
    if (!tm || !tm.daily || !tm.daily.length) {
      host.innerHTML = `<p class="chart-empty">No spending this month yet.</p>`;
      note.textContent = '';
      return;
    }
    note.textContent = monthLabelLong(tm.month);

    if (tm.total <= 0) {
      const suffix = state.isCurrentMonth ? ' yet' : '';
      host.innerHTML = `<p class="chart-empty">Nothing recorded in ${escapeHtml(monthLabelLong(tm.month))}${suffix}.</p>`;
      return;
    }

    const days = tm.daily;
    const W = 320, H = 116, padL = 30, padR = 8, padT = 10, padB = 18;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const max = Math.max(1, ...days.map((d) => d.total));
    const slot = innerW / days.length;
    const barW = Math.max(2, slot - 2); // 2px of ground between bars

    const avg = tm.avgPerDay;
    const avgY = padT + (1 - Math.min(1, avg / max)) * innerH;

    const bars = days
      .map((d, i) => {
        const h = d.total > 0 ? Math.max(2, (d.total / max) * innerH) : 0;
        const x = padL + slot * i + (slot - barW) / 2;
        const y = padT + innerH - h;
        // Only the live month has a "today". For a past month daysElapsed is
        // the full length of the month, which would otherwise accent its last
        // day as if it were now.
        const isToday = state.isCurrentMonth && i + 1 === tm.daysElapsed;
        if (h === 0) return '';
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, barW / 2).toFixed(1)}" class="chart-bar${isToday ? ' is-today' : ''}"/>`;
      })
      .join('');

    const hits = days
      .map((d, i) => `<rect x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" class="chart-hit" data-i="${i}"/>`)
      .join('');

    // Only label the first, middle and last day — a tick per day is unreadable.
    const labelIdx = [0, Math.floor(days.length / 2), days.length - 1];
    const xLabels = labelIdx
      .map((i) => `<text x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="chart-axis">${days[i].day}</text>`)
      .join('');

    host.innerHTML = `
      <div class="chart-host">
        <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Daily spending this month">
          <line x1="${padL}" y1="${(padT + innerH).toFixed(1)}" x2="${W - padR}" y2="${(padT + innerH).toFixed(1)}" class="chart-baseline"/>
          <line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${W - padR}" y2="${avgY.toFixed(1)}" class="chart-grid" stroke-dasharray="2 3"/>
          <text x="${padL - 6}" y="${(avgY + 3).toFixed(1)}" text-anchor="end" class="chart-axis">${svgEsc(moneyShort(avg))}</text>
          ${bars}
          ${xLabels}
          ${hits}
        </svg>
        <div class="chart-tip" hidden></div>
      </div>`;

    attachChartHover(host, days.map((d, i) => ({
      x: padL + slot * i + slot / 2, y: padT, W,
      title: `${monthLabel(tm.month)} ${d.day}`,
      value: money(d.total),
    })), { noCrosshair: true });
  }

  // A shared hover/tap readout. An HTML chart is interactive by default;
  // touch counts, so this binds pointer events rather than :hover.
  function attachChartHover(host, points, opts = {}) {
    const svg = host.querySelector('svg');
    const tip = host.querySelector('.chart-tip');
    const cross = svg.querySelector('.chart-crosshair');
    if (!svg || !tip) return;

    const show = (i) => {
      const p = points[i];
      if (!p) return;
      tip.innerHTML = `<span class="chart-tip-title">${escapeHtml(p.title)}</span><span class="chart-tip-value">${escapeHtml(p.value)}</span>`;
      tip.hidden = false;
      const rect = svg.getBoundingClientRect();
      const px = (p.x / p.W) * rect.width;
      tip.style.left = `${Math.max(4, Math.min(px, rect.width - 4))}px`;
      if (cross && !opts.noCrosshair) {
        cross.setAttribute('x1', p.x);
        cross.setAttribute('x2', p.x);
        cross.style.display = '';
      }
    };
    const hide = () => {
      tip.hidden = true;
      if (cross) cross.style.display = 'none';
    };

    svg.querySelectorAll('.chart-hit').forEach((hit) => {
      const i = Number(hit.dataset.i);
      hit.addEventListener('pointerenter', () => show(i));
      hit.addEventListener('pointerdown', () => show(i));
    });
    svg.addEventListener('pointerleave', hide);
    host.addEventListener('pointercancel', hide);
  }

  // --- Ranked magnitude list --------------------------------------------
  function rankListHtml(rows, { getLabel, getTotal, emptyText }) {
    if (!rows.length) return `<p class="chart-empty">${escapeHtml(emptyText)}</p>`;
    const max = Math.max(1, ...rows.map(getTotal));
    const sum = rows.reduce((s, r) => s + getTotal(r), 0);
    return rows
      .map((r) => {
        const total = getTotal(r);
        const pct = Math.max(1.5, (total / max) * 100);
        const share = sum > 0 ? Math.round((total / sum) * 100) : 0;
        return `
        <div class="rank-row">
          <div class="rank-top">
            <span class="rank-name">${getLabel(r)}</span>
            <span class="rank-share">${share}%</span>
            <span class="rank-value">${money(total)}</span>
          </div>
          <div class="rank-track"><div class="rank-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>`;
      })
      .join('');
  }

  function renderAnalytics() {
    const a = state.analytics;
    if (!a) return;

    const tm = a.thisMonth || { total: 0, count: 0, avgPerDay: 0, largest: null, daysElapsed: 0, daily: [] };
    const monthName = monthLabelLong(a.month);
    const inMonth = state.isCurrentMonth ? 'this month' : monthLabel(a.month);

    // Every heading names the month being shown, so a screenshot of a history
    // month can never be mistaken for the live one.
    $('#an-total-label').textContent = state.isCurrentMonth ? 'This month' : monthLabel(a.month);
    $('#daily-panel-title').textContent = state.isCurrentMonth ? 'This month, day by day' : `${monthName}, day by day`;
    $('#category-month-note').textContent = monthLabel(a.month);

    // Stat strip
    $('#an-total').textContent = money(tm.total);
    // Why there's no percentage matters: no data of our own, no month before
    // us, or a predecessor that was empty are three different situations and
    // only the middle one is "first month".
    const noDelta = tm.total <= 0
      ? 'no spending'
      : a.month === state.availableMonths[0]
        ? 'first month'
        : 'nothing last month';
    $('#an-delta').innerHTML = deltaHtml(a.momChange) || `<span class="delta">${noDelta}</span>`;
    $('#an-avg').textContent = money(tm.avgPerDay);
    $('#an-avg-sub').textContent = tm.daysElapsed ? `over ${tm.daysElapsed} day${tm.daysElapsed === 1 ? '' : 's'}` : '—';
    $('#an-count').textContent = String(tm.count);
    $('#an-count-sub').textContent = tm.count ? `${money(tm.count ? tm.total / tm.count : 0)} average` : inMonth;
    $('#an-max').textContent = tm.largest ? money(tm.largest.amount) : money(0);
    $('#an-max-sub').textContent = tm.largest ? tm.largest.description : inMonth;

    renderTrendChart(a.monthly);
    renderDailyChart(tm);

    $('#category-bars').innerHTML = rankListHtml(a.categoryTotals.filter((c) => c.total > 0), {
      getLabel: (c) => `${catIconHtml(c.category, 'cat-icon-wrap-sm')}<span>${escapeHtml(c.category)}</span>`,
      getTotal: (c) => c.total,
      emptyText: 'No expenses yet.',
    });

    const spenders = a.memberTotals.filter((m) => m.total > 0);
    $('#top-spender-note').textContent = a.topSpender ? `Top: ${a.topSpender.name}` : '';
    $('#member-bars').innerHTML = rankListHtml(spenders, {
      getLabel: (m) => `${avatarHtml(m.avatar, 'avatar-xs')}<span>${escapeHtml(m.name)}</span>`,
      getTotal: (m) => m.total,
      emptyText: 'No expenses yet.',
    });

    const places = a.topLocations || [];
    $('#places-panel').classList.toggle('hidden', places.length === 0);
    if (places.length) {
      $('#top-places').innerHTML = rankListHtml(places, {
        getLabel: (p) => `<span class="cat-icon-wrap-sm tint-indigo"><svg><use href="#icon-place"/></svg></span><span>${escapeHtml(p.location)}</span>`,
        getTotal: (p) => p.total,
        emptyText: 'No places recorded yet.',
      });
    }

    renderSettleUp(a.settleUp);
    renderAnalyticsSharing(a);
  }

  // When somebody paused or resumed mid-month the month is not one split but
  // several, and quoting a single "£X each" would be a lie. So the month says
  // where it was cut, and opens up to show each stretch on its own terms:
  // what was spent in it, who was sharing, and what that came to per head.
  //
  // Nothing renders at all in the ordinary case — one segment means nobody
  // paused, and there is nothing to explain.
  // Who is sharing the month being viewed: every face, in or paused, and what
  // each paid against their share. Always drawn — it is the one place the
  // split is explained member by member, whether or not anyone paused.
  function renderAnalyticsSharing(a) {
    const list = $('#an-sharing-list');
    if (!list) return;
    const settle = a.settleUp;
    const part = a.participation;
    const roster = (settle && settle.balances) || [];
    const byId = new Map((part ? part.members : []).map((m) => [m.memberId, m]));
    const statusOf = (id) => {
      const m = byId.get(id);
      if (!m) return 'in';
      return state.isCurrentMonth ? m.statusNow : m.statusAtMonthEnd;
    };

    const inCount = roster.filter((b) => statusOf(b.memberId) === 'in').length;
    $('#an-sharing-note').textContent = roster.length ? `${inCount} of ${roster.length}` : '';

    if (!roster.length) {
      list.innerHTML = `<p class="chart-empty">Nobody was in the room in ${escapeHtml(monthLabelLong(a.month))}.</p>`;
      return;
    }

    // Faces in a row, names under them. Paused people stay, dimmed, with the
    // one word that explains why — the only thing that differs between them.
    list.innerHTML = roster
      .map((b) => {
        const m = byId.get(b.memberId);
        const out = statusOf(b.memberId) !== 'in';
        const next = state.isCurrentMonth && m && m.scheduled && m.scheduled.length ? m.scheduled[0] : null;
        const tag = next
          ? `<span class="an-face-tag">${next.status === 'out' ? 'from' : 'back'} ${escapeHtml(shortDay(next.effectiveFrom))}</span>`
          : out ? '<span class="an-face-tag">paused</span>' : '';
        const name = b.memberId === state.member.id ? 'You' : b.name;
        return `
        <div class="an-face${out ? ' is-paused' : ''}" title="${escapeHtml(b.name)}${out ? ' — paused' : ''}">
          ${avatarHtml(b.avatar, 'avatar-md')}
          <span class="an-face-name">${escapeHtml(name)}</span>${tag}
        </div>`;
      })
      .join('');
  }

  function renderSegmentNotice(settle) {
    const btn = $('#seg-notice');
    const body = $('#seg-breakdown');
    if (!btn || !body) return;

    const segs = (settle && settle.segments) || [];
    if (!settle || !settle.isSegmented || segs.length < 2) {
      btn.classList.add('hidden');
      body.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      return;
    }

    // Name the changes, not the segments — "Dan paused on the 15th" is what
    // happened; "there are two segments" is only how it is stored.
    const names = new Map((state.members || []).map((m) => [m.id, m.name]));
    const events = [];
    for (let i = 1; i < segs.length; i++) {
      const before = new Set(segs[i - 1].memberIds);
      const after = new Set(segs[i].memberIds);
      for (const id of before) if (!after.has(id)) events.push(`${names.get(id) || 'Someone'} paused on ${shortDay(segs[i].from)}`);
      for (const id of after) if (!before.has(id)) events.push(`${names.get(id) || 'Someone'} resumed on ${shortDay(segs[i].from)}`);
    }
    $('#seg-notice-text').textContent = events.length
      ? events.join(' · ')
      : `Who was sharing changed during ${monthLabelLong(settle.month)}`;
    btn.classList.remove('hidden');

    body.innerHTML = segs
      .map((seg) => {
        const faces = seg.memberIds
          .map((id) => {
            const m = (state.members || []).find((x) => x.id === id);
            return m ? `<span title="${escapeHtml(m.name)}">${avatarHtml(m.avatar, 'avatar-xs')}</span>` : '';
          })
          .join('');
        return `
        <div class="seg-row">
          <div class="seg-row-when">${escapeHtml(shortDay(seg.from))} – ${escapeHtml(shortDay(seg.to))}</div>
          <div class="seg-row-faces">${faces}</div>
          <div class="seg-row-figures">
            <span class="seg-row-total">${money(seg.total)}</span>
            <span class="seg-row-each">${seg.memberCount ? `${money(seg.perHead)} each` : 'nobody sharing'}</span>
          </div>
        </div>`;
      })
      .join('');
  }

  // "5 Sep" — enough to place a day inside a month you are already looking at.
  function shortDay(iso) {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function initSegmentNotice() {
    const btn = $('#seg-notice');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      $('#seg-breakdown').classList.toggle('hidden', open);
    });
  }

  function renderSettleUp(settle) {
    const list = $('#settle-list');
    const balWrap = $('#settle-balances');
    const hint = $('#settle-hint');
    $('#settle-month-note').textContent = settle ? monthLabel(settle.month) : '';
    renderSettlementStatus(settle);
    if (!settle) { list.innerHTML = ''; balWrap.innerHTML = ''; return; }

    renderSegmentNotice(settle);

    // With a pause in the month there is no single "each" figure to quote, so
    // the hint stops pretending there is and points at the breakdown instead.
    hint.textContent = settle.isSegmented
      ? `${money(settle.totalSpend)} across ${settle.balances.length} member${settle.balances.length === 1 ? '' : 's'} — not an even split this month, because who was sharing changed.`
      : `${money(settle.totalSpend)} across ${settle.balances.length} member${settle.balances.length === 1 ? '' : 's'} — an even split is ${money(settle.fairShare)} each.`;

    if (settle.totalSpend <= 0) {
      balWrap.innerHTML = '';
      list.innerHTML = state.isCurrentMonth
        ? `<p class="chart-empty">No expenses this month yet.</p>`
        : `<p class="chart-empty">Nothing to settle — no expenses in ${escapeHtml(monthLabelLong(settle.month))}.</p>`;
      return;
    }

    // A centred meter shows over/under at a glance; the signed value beside
    // it is the actual reading, so the bar never has to be measured.
    const maxAbs = Math.max(0.01, ...settle.balances.map((b) => Math.abs(b.balance)));
    balWrap.innerHTML = settle.balances
      .map((b) => {
        const w = (Math.abs(b.balance) / maxAbs) * 50;
        const pos = b.balance > 0.005;
        const neg = b.balance < -0.005;
        const bar = pos
          ? `<i class="pos" style="width:${w.toFixed(1)}%"></i>`
          : neg ? `<i class="neg" style="width:${w.toFixed(1)}%"></i>` : '';
        const cls = pos ? 'pos' : neg ? 'neg' : '';
        const sign = pos ? '+' : neg ? '−' : '';
        return `
        <div class="settle-bal-row">
          ${avatarHtml(b.avatar, 'avatar-xs')}
          <span class="settle-bal-name">${escapeHtml(b.name)}</span>
          <span class="settle-bal-meter">${bar}</span>
          <span class="settle-bal-value ${cls}">${sign}${money(Math.abs(b.balance))}</span>
        </div>`;
      })
      .join('');

    if (!settle.transactions.length) {
      const when = state.isCurrentMonth ? 'this month' : `in ${monthLabelLong(settle.month)}`;
      list.innerHTML = `<p class="settle-even">Everyone's already even ${escapeHtml(when)}</p>`;
      return;
    }

    list.innerHTML = settle.transactions
      .map((t) => `
        <div class="settle-row">
          ${avatarHtml(t.from.avatar, 'avatar-sm')}
          <div class="settle-row-text"><strong>${escapeHtml(t.from.name)}</strong> pays <strong>${escapeHtml(t.to.name)}</strong></div>
          <span class="settle-arrow"><svg><use href="#icon-arrow-right"/></svg></span>
          <div class="settle-amount">${money(t.amount)}</div>
        </div>`)
      .join('');
  }

  // ---------------------------------------------------------------------
  // Settle-up agreement
  //
  // Who owes who is always recomputed from the expenses. This block only
  // records what the room *says* happened — that the payments were made — so
  // nothing here can move a figure. Agreeing is a signal, not a transaction.
  // ---------------------------------------------------------------------
  function settlePeopleHtml(participants) {
    return `<div class="settle-people">${participants
      .map((p) => `
        <span class="settle-person ${p.approved ? 'agreed' : 'waiting'}">
          ${avatarHtml(p.avatar, 'avatar-xs')}
          <svg><use href="#icon-${p.approved ? 'check' : 'clock'}"/></svg>
          ${escapeHtml(p.name)}${p.memberId === state.member.id ? ' (You)' : ''}
        </span>`)
      .join('')}</div>`;
  }

  function renderSettlementStatus(settle) {
    const host = $('#settle-status');
    if (!host) return;

    const s = settle && settle.settlement;
    const canSettle = !!settle && settle.totalSpend > 0 && settle.transactions.length > 0;
    const iAmInMonth = !!settle && settle.balances.some((b) => b.memberId === state.member.id);
    const parts = [];

    if (s) {
      const mine = s.participants.find((p) => p.memberId === state.member.id);
      const settled = s.status === 'settled';
      const canClose = s.requestedBy && (s.requestedBy.id === state.member.id || state.member.isHost);

      parts.push(settled
        ? `<span class="settle-badge is-settled"><svg><use href="#icon-check"/></svg>Settled up</span>`
        : `<span class="settle-badge is-pending"><svg><use href="#icon-clock"/></svg>${s.approvedCount} of ${s.participantCount} agreed</span>`);

      if (s.stale) {
        parts.push(`<span class="settle-badge is-stale"><svg><use href="#icon-warning"/></svg>Spending changed</span>`);
      }

      parts.push(settled
        ? `<p class="settle-status-note">Everyone agreed these payments were made${s.settledAt ? ` on <strong>${escapeHtml(absDate(s.settledAt))}</strong>` : ''}.</p>`
        : `<p class="settle-status-note"><strong>${escapeHtml(s.requestedBy ? s.requestedBy.name : 'Someone')}</strong> asked everyone to settle up${s.createdAt ? ` on ${escapeHtml(absDate(s.createdAt))}` : ''}. It is marked settled once everyone agrees.</p>`);

      if (s.stale) {
        // Never silently void the agreement — people acted on it. Say the
        // month moved and let a human decide whether that matters.
        parts.push(`<p class="settle-status-note">This month held ${money(s.totalSpendAtRequest)} when that was agreed and now holds <strong>${money(settle.totalSpend)}</strong>. The amounts above are the current ones.</p>`);
      }

      parts.push(settlePeopleHtml(s.participants));

      const actions = [];
      if (!settled && mine && !mine.approved) {
        actions.push(`<button type="button" class="btn-primary" data-settle-action="approve"><svg class="icon-sm"><use href="#icon-check"/></svg> I've paid up — agree</button>`);
      } else if (!settled && mine && mine.approved) {
        actions.push(`<button type="button" class="btn-secondary" disabled>You've agreed — waiting for ${s.participantCount - s.approvedCount} more</button>`);
      }
      if (canClose) {
        actions.push(`<button type="button" class="btn-ghost" data-settle-action="cancel">${settled ? 'Reopen this month' : 'Cancel this request'}</button>`);
      }
      if (actions.length) parts.push(`<div class="settle-actions">${actions.join('')}</div>`);
    } else if (canSettle && iAmInMonth) {
      parts.push(`<p class="settle-status-note">Once these payments have actually been made, ask everyone to confirm it.</p>`);
      parts.push(`<div class="settle-actions"><button type="button" class="btn-secondary" data-settle-action="request"><svg class="icon-sm"><use href="#icon-scale"/></svg> Request settle-up</button></div>`);
    }

    // A request raised for another month is invisible from here — you would
    // have to guess which month to go and look at.
    const elsewhere = state.pendingSettleRequests.filter((r) => r.month !== state.activeMonth);
    if (elsewhere.length) {
      parts.push(`<p class="settle-status-note">Waiting on you: ${elsewhere
        .map((r) => `<a href="#" data-settle-goto="${escapeHtml(r.month)}">${escapeHtml(monthLabelLong(r.month))}</a>`)
        .join(', ')}.</p>`);
    }

    host.innerHTML = parts.join('');

    host.querySelectorAll('[data-settle-action]').forEach((btn) =>
      btn.addEventListener('click', () => settlementAction(btn.dataset.settleAction))
    );
    host.querySelectorAll('[data-settle-goto]').forEach((a) =>
      a.addEventListener('click', (e) => { e.preventDefault(); goToMonth(a.dataset.settleGoto, { manual: true }); })
    );
  }

  async function settlementAction(action) {
    const settle = state.analytics && state.analytics.settleUp;
    const s = settle && settle.settlement;

    if (action === 'request') {
      const month = state.activeMonth;
      openConfirm({
        title: `Settle up ${monthLabelLong(month)}?`,
        body: `Everyone in this month will be asked to confirm the payments above have been made. It is marked settled once they all agree. Nothing is added, changed or removed.`,
        confirmLabel: 'Ask everyone',
        danger: false,
        onConfirm: async () => {
          await api('/api/settlement', { method: 'POST', body: JSON.stringify({ month }) });
          toast('Everyone has been asked to confirm');
          await refreshAnalytics();
        },
      });
      return;
    }

    if (!s) return;

    if (action === 'approve') {
      try {
        await api(`/api/settlement/${s.id}/approve`, { method: 'POST' });
        toast('You agreed');
        await refreshAnalytics();
      } catch (err) {
        toast(err.message);
        await refreshAnalytics();
      }
      return;
    }

    if (action === 'cancel') {
      const settled = s.status === 'settled';
      openConfirm({
        title: settled ? 'Reopen this month?' : 'Cancel this request?',
        body: settled
          ? `${monthLabelLong(s.month)} will no longer be marked settled. No expense is touched — only the agreement is withdrawn.`
          : `The settle-up request for ${monthLabelLong(s.month)} will be withdrawn, including the agreements already given.`,
        confirmLabel: settled ? 'Reopen' : 'Cancel request',
        cancelLabel: 'Keep it',
        danger: true,
        onConfirm: async () => {
          await api(`/api/settlement/${s.id}`, { method: 'DELETE' });
          toast(settled ? 'Month reopened' : 'Request withdrawn');
          await refreshAnalytics();
        },
      });
    }
  }

  // =======================================================================
  // ACTIVITY LOG
  // =======================================================================
  function renderActivity() {
    const list = $('#activity-list');
    list.innerHTML = '';
    $('#activity-empty').classList.toggle('hidden', state.activity.length > 0);
    const empty = $('#activity-empty-text');
    if (empty) empty.textContent = 'Nothing has happened in this room yet.';
    for (const a of state.activity) list.appendChild(activityNode(a));
  }

  function activityNode(a) {
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = `
      ${avatarHtml(a.memberAvatar, 'avatar-sm')}
      <div class="activity-body">
        <div class="activity-text">${escapeHtml(a.message)}</div>
        <div class="activity-time" title="${escapeHtml(absDateTime(a.createdAt))}">${escapeHtml(relTime(a.createdAt))} · ${escapeHtml(absDateTime(a.createdAt))}</div>
      </div>`;
    return div;
  }

  // The stream is unscoped, so anything arriving now belongs at the top of it.
  function prependActivity(a) {
    state.activity.unshift(a);
    state.activity = state.activity.slice(0, 60);
    const list = $('#activity-list');
    $('#activity-empty').classList.add('hidden');
    list.insertBefore(activityNode(a), list.firstChild);
  }

  // =======================================================================
  // PROFILE
  // =======================================================================
  let pinRevealed = false;

  function renderProfile() {
    if (!state.member || !state.room) return;
    $('#host-tools-card').classList.toggle('hidden', !state.member.isHost);
    renderSharingCard();
    $('#profile-avatar-xl').innerHTML = avatarHtml(state.member.avatar, 'avatar-xl');
    $('#profile-hero-name').textContent = state.member.name;
    $('#profile-hero-role').textContent = state.member.isHost ? 'Host' : 'Member';

    $('#profile-name').textContent = state.member.name;
    $('#profile-pin').textContent = pinRevealed && state._cachedPin ? state._cachedPin : '••••';
    $('#profile-pin-toggle').innerHTML = `<svg class="icon-sm"><use href="#icon-${pinRevealed ? 'eye-off' : 'eye'}"/></svg>`;

    $('#profile-room-name').textContent = state.room.name;
    $('#profile-room-id').textContent = state.room.id;
    $('#profile-room-password').textContent = state._cachedRoomPassword || 'Ask your host';

    if (state.roomInfo) {
      $('#profile-member-count').textContent = String(state.roomInfo.memberCount);
      $('#profile-created').textContent = new Date(state.roomInfo.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      $('#profile-lifetime').textContent = money(state.roomInfo.totalLifetimeSpend);
    }

  }

  // =======================================================================
  // MONTHLY SHARING — the controls
  //
  // Home shows who is sharing; this is where it changes. A member asks and the
  // host decides, which is the whole safety property: if anyone could pause
  // themselves, anyone could walk away from a bill they were already in. The
  // host acts directly, on themselves or on anyone else.
  // =======================================================================
  function participation() {
    return (state.homeAnalytics && state.homeAnalytics.participation) || state.participation || null;
  }

  function renderSharingCard() {
    const card = $('#sharing-card');
    if (!card || !state.member) return;
    const part = participation();
    const people = part ? part.members : [];
    const isHost = !!state.member.isHost;

    const sharing = people.filter((m) => m.statusNow === 'in').length;
    $('#sharing-note').textContent = people.length ? `${sharing} of ${people.length} sharing` : '';

    // Pending asks. The host sees them as decisions; everyone else sees that
    // they are waiting, which is what stops the same ask being sent twice.
    const reqs = part ? part.requests : [];
    const reqWrap = $('#sharing-requests');
    reqWrap.innerHTML = reqs.length
      ? reqs
          .map((r) => {
            const mine = r.memberId === state.member.id;
            const what = r.status === 'out' ? 'pause' : 'resume';
            const line = `<strong>${escapeHtml(mine ? 'You' : r.memberName)}</strong> asked to ${what} from <strong>${escapeHtml(shortDay(r.effectiveFrom))}</strong>`;
            const actions = isHost
              ? `<div class="sharing-req-actions">
                   <button type="button" class="btn-primary btn-sm" data-req-approve="${r.id}">Approve</button>
                   <button type="button" class="btn-ghost btn-sm" data-req-decline="${r.id}">Decline</button>
                 </div>`
              : mine
                ? `<div class="sharing-req-actions"><button type="button" class="btn-ghost btn-sm" data-req-cancel="${r.id}">Withdraw</button></div>`
                : `<div class="sharing-req-wait">Waiting on the host</div>`;
            return `<div class="sharing-req">${avatarHtml(r.memberAvatar, 'avatar-xs')}<div class="sharing-req-text">${line}</div>${actions}</div>`;
          })
          .join('')
      : '';

    // Everyone, with where they stand and anything already scheduled. The host
    // carries a Leader tag — the one person whose word changes the list.
    const leaderIds = new Set((state.members || []).filter((x) => x.isHost).map((x) => x.id));
    $('#sharing-people').innerHTML = people
      .map((m) => {
        const out = m.statusNow !== 'in';
        const next = m.scheduled && m.scheduled.length ? m.scheduled[0] : null;
        const sub = next
          ? `${next.status === 'out' ? 'Pausing' : 'Resuming'} ${escapeHtml(shortDay(next.effectiveFrom))}`
          : out ? 'Paused' : 'Sharing';
        return `
        <div class="sharing-person${out ? ' is-paused' : ''}">
          ${avatarHtml(m.avatar, 'avatar-md')}
          <div class="sharing-person-info">
            <div class="sharing-person-name"><span class="sharing-person-text">${escapeHtml(m.name)}${m.memberId === state.member.id ? ' (You)' : ''}</span>${leaderIds.has(m.memberId) ? '<span class="leader-tag">Leader</span>' : ''}</div>
            <div class="sharing-person-sub">${sub}</div>
          </div>
          <span class="sharing-pill${out ? ' is-paused' : ''}">${out ? 'Paused' : 'Sharing'}</span>
        </div>`;
      })
      .join('');

    $('#sharing-change-label').textContent = isHost ? 'Change sharing' : 'Request a change';

    reqWrap.querySelectorAll('[data-req-approve]').forEach((b) =>
      b.addEventListener('click', () => decideRequest(b.dataset.reqApprove, 'approve')));
    reqWrap.querySelectorAll('[data-req-decline]').forEach((b) =>
      b.addEventListener('click', () => decideRequest(b.dataset.reqDecline, 'decline')));
    reqWrap.querySelectorAll('[data-req-cancel]').forEach((b) =>
      b.addEventListener('click', () => cancelRequest(b.dataset.reqCancel)));
  }

  async function decideRequest(id, decision) {
    try {
      await api(`/api/participation/request/${id}/${decision}`, { method: 'POST' });
      toast(decision === 'approve' ? 'Approved' : 'Declined');
      await refreshAll();
    } catch (err) { toast(err.message); }
  }

  async function cancelRequest(id) {
    try {
      await api(`/api/participation/request/${id}`, { method: 'DELETE' });
      toast('Request withdrawn');
      await refreshAll();
    } catch (err) { toast(err.message); }
  }

  function openSharingModal() {
    const isHost = !!state.member.isHost;
    const part = participation();
    const people = part ? part.members : [];

    // A member can only speak for themselves, so the picker is only worth
    // showing to the host.
    $('#sharing-who-field').classList.toggle('hidden', !isHost);
    $('#sharing-who').innerHTML = people
      .map((m) => `<option value="${m.memberId}"${m.memberId === state.member.id ? ' selected' : ''}>${escapeHtml(m.name)}${m.memberId === state.member.id ? ' (You)' : ''}</option>`)
      .join('');

    // The window the server will accept, drawn as the picker's own limits so
    // nobody discovers the rule by being refused by it.
    const from = $('#sharing-from');
    from.min = `${currentMonthKey()}-01`;
    from.max = `${addMonthsKey(currentMonthKey(), 17)}-01`;
    from.value = todayKey();

    $('#sharing-submit').textContent = isHost ? 'Apply change' : 'Send request';
    updateSharingHint();
    $('#sharing-modal').classList.remove('hidden');
  }

  function verbShort(what, when) {
    return what === 'out'
      ? `From ${when} they stop sharing the bill and can't add spending.`
      : `From ${when} they share the bill again.`;
  }

  function updateSharingHint() {
    const isHost = !!state.member.isHost;
    const what = $('#sharing-what').value;
    const day = $('#sharing-from').value;
    const when = day ? shortDay(day) : 'that day';
    $('#sharing-hint').textContent = isHost
      ? `${verbShort(what, when)} The month's settle-up works out who pays whom, counting them only for the days they shared.`
      : what === 'out'
        ? `Asks the host to pause you from ${when}: you stop sharing the bill and can't add spending. Takes effect once they approve.`
        : `Asks the host to let you share the bill again from ${when}. Takes effect once they approve.`;
  }

  async function submitSharing(ev) {
    ev.preventDefault();
    const isHost = !!state.member.isHost;
    const status = $('#sharing-what').value;
    const effectiveFrom = $('#sharing-from').value;
    try {
      if (isHost) {
        await api('/api/participation/set', {
          method: 'POST',
          body: JSON.stringify({ memberId: Number($('#sharing-who').value), status, effectiveFrom }),
        });
        toast('Sharing updated');
      } else {
        await api('/api/participation/request', {
          method: 'POST',
          body: JSON.stringify({ status, effectiveFrom }),
        });
        toast('Sent to the host');
      }
      $('#sharing-modal').classList.add('hidden');
      await refreshAll();
    } catch (err) { toast(err.message); }
  }

  function initSharing() {
    $('#sharing-change-btn').addEventListener('click', openSharingModal);
    $('#sharing-close').addEventListener('click', () => $('#sharing-modal').classList.add('hidden'));
    $('#sharing-modal').addEventListener('click', (ev) => {
      if (ev.target === $('#sharing-modal')) $('#sharing-modal').classList.add('hidden');
    });
    $('#sharing-what').addEventListener('change', updateSharingHint);
    $('#sharing-from').addEventListener('change', updateSharingHint);
    $('#sharing-form').addEventListener('submit', submitSharing);

    // ---- handing over the host ----
    $('#handover-host-btn').addEventListener('click', () => {
      const others = state.members.filter((m) => m.id !== state.member.id);
      $('#handover-list').innerHTML = others.length
        ? others
            .map((m) => `
          <button type="button" class="handover-row" data-handover="${m.id}">
            ${avatarHtml(m.avatar, 'avatar-md')}
            <span class="handover-name">${escapeHtml(m.name)}</span>
            <svg class="icon-sm"><use href="#icon-chevron"/></svg>
          </button>`)
            .join('')
        : `<p class="chart-empty">There is nobody else in this room yet.</p>`;
      $('#handover-list').querySelectorAll('[data-handover]').forEach((b) =>
        b.addEventListener('click', () => confirmHandover(Number(b.dataset.handover))));
      $('#handover-modal').classList.remove('hidden');
    });
    $('#handover-close').addEventListener('click', () => $('#handover-modal').classList.add('hidden'));
    $('#handover-modal').addEventListener('click', (ev) => {
      if (ev.target === $('#handover-modal')) $('#handover-modal').classList.add('hidden');
    });
  }

  function confirmHandover(memberId) {
    const target = state.members.find((m) => m.id === memberId);
    if (!target) return;
    $('#handover-modal').classList.add('hidden');
    openConfirm({
      title: `Make ${target.name} the host?`,
      body: `${target.name} gets the host tools — categories, sharing approvals, and handing the host on. You keep everything else, but only ${target.name} can give it back.`,
      confirmLabel: 'Hand over',
      danger: true,
      onConfirm: async () => {
        await api('/api/room/host', { method: 'POST', body: JSON.stringify({ memberId }) });
        toast(`${target.name} is now the host`);
        await Promise.all([refreshMembers(), refreshSession()]);
        renderProfile();
        await refreshAll();
      },
    });
  }

  function initProfile() {
    $('#profile-pin-toggle').addEventListener('click', () => {
      pinRevealed = !pinRevealed;
      renderProfile();
    });

    $('[data-copy="room-id"]').addEventListener('click', () => copyToClipboard(state.room.id, 'Room ID copied'));

    $('#profile-avatar-edit-btn').addEventListener('click', () => openAvatarModal());

    $('#leave-room-btn').addEventListener('click', () => {
      openConfirm({
        title: 'Leave this room?',
        body: `You'll be signed out of "${state.room.name}" on this device. Your data stays safe on the server — you can rejoin anytime with the Room ID, password, your name and PIN.`,
        confirmLabel: 'Leave room',
        danger: true,
        onConfirm: () => doLogout(),
      });
    });
  }

  async function copyToClipboard(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch (_) {
      toast('Could not copy — long-press to copy manually');
    }
  }

  async function doLogout() {
    try { await api('/api/session/logout', { method: 'POST' }); } catch (_) { /* best effort */ }
    if (state.ws) { try { state.ws.close(); } catch (_) {} }

    clearCreds();
    state.token = null;
    state.room = null;
    state.member = null;

    $('#app').classList.add('hidden');
    showAuth();

    $('#form-join').reset();
    $('#form-create').reset();
    showAuthWelcome();
  }

  // =======================================================================
  // GUIDED TOUR
  // =======================================================================
  const TOUR_STORAGE_KEY = 'finledge_tour_seen_v1';

  const TOUR_STEPS = [
    {
      title: 'Welcome to Finledge',
      body: "Track your room's spending and split it fairly. Quick tour.",
    },
    {
      target: ['.hero'],
      title: 'This month',
      body: 'Home is always the current month: what the room has spent, how it compares to last month, and whether you are owed money or owe it.',
    },
    {
      target: ['#tx-list .tx-card', '#tx-empty', '#tx-list'],
      title: 'Recent transactions',
      body: "This month's spending, newest first. Tap one to see its details.",
    },
    {
      target: ['#fab-add'],
      title: 'Add an expense',
      body: 'Tap + to log a spend: enter the amount, pick a category, then an item icon. It saves instantly and everyone in the room sees it. A month stays open for 7 days after it ends, then closes — nothing can be added to it, and nothing can be dated in the future.',
    },
    {
      target: ['.nav-btn[data-view="analytics"]'],
      title: 'Analytics',
      body: "Trends, day-by-day spending, where the money goes, and Settle Up — who owes who, and a way to mark a month settled once everyone has paid up. It follows whichever month you pick in History.",
    },
    {
      target: ['.nav-btn[data-view="history"]'],
      title: 'Past months',
      body: 'History is where closed months live. Pick a month at the top — the last two are one tap, "Previous" opens the full 18 months — and you get that month\u2019s total and every transaction in it. Search and filter live here too. Swipe a transaction left to edit or delete it; closed months are read-only.',
    },
    {
      target: ['.nav-btn[data-view="activity"]'],
      title: 'Activity',
      body: 'A running log of everything anyone in the room has added, edited or deleted, newest first.',
    },
    {
      target: ['.nav-btn[data-view="profile"]'],
      title: 'Profile & room',
      body: 'Your details, Room ID and password, everyone in the room, and your avatar.',
    },
    {
      title: "You're ready",
      body: 'Tap + to add your first expense. Replay this tour anytime from Profile.',
      finishLabel: "Let's go",
    },
  ];

  let tourIndex = 0;

  function hasSeenTour() {
    return localStorage.getItem(TOUR_STORAGE_KEY) === '1';
  }

  function markTourSeen() {
    localStorage.setItem(TOUR_STORAGE_KEY, '1');
  }

  // ---- what's new -------------------------------------------------------
  // Bump the key for the next update's notice. Stored per device, like the
  // tour, and every access is guarded: private mode can throw on storage.
  const WHATSNEW_KEY = 'finledge_whatsnew_2026_09';

  function whatsNewSeen() {
    try { return localStorage.getItem(WHATSNEW_KEY) === '1'; } catch (_) { return true; }
  }

  function markWhatsNewSeen() {
    try { localStorage.setItem(WHATSNEW_KEY, '1'); } catch (_) { /* shown again next time */ }
  }

  function maybeShowWhatsNew() {
    if (whatsNewSeen()) return;
    $('#whatsnew-read').checked = false;
    $('#whatsnew-close').disabled = true;
    $('#whatsnew-modal').classList.remove('hidden');
  }

  function initWhatsNew() {
    $('#whatsnew-read').addEventListener('change', (e) => { $('#whatsnew-close').disabled = !e.target.checked; });
    $('#whatsnew-close').addEventListener('click', () => {
      if (!$('#whatsnew-read').checked) return;
      markWhatsNewSeen();
      $('#whatsnew-modal').classList.add('hidden');
    });
  }

  function maybeStartTour() {
    // Someone new gets the tour, which already covers today's app — they have
    // no "before" for an update notice to compare against. Everyone else sees
    // what changed, once.
    if (hasSeenTour()) { maybeShowWhatsNew(); return; }
    markWhatsNewSeen();
    switchView('home');
    requestAnimationFrame(() => requestAnimationFrame(startTour));
  }

  function startTour() {
    tourIndex = 0;
    $('#tour-overlay').classList.remove('hidden');
    window.addEventListener('resize', tourReposition);
    showTourStep();
  }

  function endTour() {
    markTourSeen();
    $('#tour-overlay').classList.add('hidden');
    window.removeEventListener('resize', tourReposition);
  }

  function tourReposition() {
    if ($('#tour-overlay').classList.contains('hidden')) return;
    showTourStep(true);
  }

  function resolveTourTargetEl(step) {
    if (!step.target) return null;
    for (const sel of step.target) {
      const el = $(sel);
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }

  // Content and position are applied together, never one before the other,
  // or the new step's text shows for a beat beside the old highlight.
  function applyTourContent(step) {
    $('#tour-step-count').textContent = `Step ${tourIndex + 1} of ${TOUR_STEPS.length}`;
    $('#tour-title').textContent = step.title;
    $('#tour-body').textContent = step.body;
    $('#tour-back').classList.toggle('hidden', tourIndex === 0);
    $('#tour-next').textContent = step.finishLabel || (tourIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next');
    $('#tour-skip').classList.toggle('hidden', tourIndex === TOUR_STEPS.length - 1);
  }

  function showTourStep(isReposition) {
    const step = TOUR_STEPS[tourIndex];
    const overlay = $('#tour-overlay');
    const spotlight = $('#tour-spotlight');
    const tooltip = $('#tour-tooltip');

    const el = resolveTourTargetEl(step);

    if (!el) {
      applyTourContent(step);
      overlay.classList.add('centered');
      tooltip.style.opacity = '';
      return;
    }
    overlay.classList.remove('centered');

    const place = () => {
      const rect = el.getBoundingClientRect();
      const pad = 8;
      spotlight.style.left = `${rect.left - pad}px`;
      spotlight.style.top = `${rect.top - pad}px`;
      spotlight.style.width = `${rect.width + pad * 2}px`;
      spotlight.style.height = `${rect.height + pad * 2}px`;

      applyTourContent(step);

      const margin = 14;
      const ttW = tooltip.offsetWidth;
      const ttH = tooltip.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      let top;
      if (spaceBelow >= ttH + margin || spaceBelow >= spaceAbove) {
        top = Math.min(rect.bottom + margin, window.innerHeight - ttH - margin);
      } else {
        top = Math.max(margin, rect.top - ttH - margin);
      }
      let left = rect.left + rect.width / 2 - ttW / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - ttW - margin));
      tooltip.style.top = `${Math.max(margin, top)}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.opacity = '1';
    };

    if (!isReposition) {
      tooltip.style.opacity = '0';
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(place, 220);
    } else {
      place();
    }
  }

  function initTour() {
    $('#tour-next').addEventListener('click', () => {
      if (tourIndex >= TOUR_STEPS.length - 1) { endTour(); return; }
      tourIndex++;
      showTourStep();
    });
    $('#tour-back').addEventListener('click', () => {
      if (tourIndex === 0) return;
      tourIndex--;
      showTourStep();
    });
    $('#tour-skip').addEventListener('click', endTour);

    $('#replay-tour-btn').addEventListener('click', () => {
      switchView('home');
      tourIndex = 0;
      $('#tour-overlay').classList.remove('hidden');
      window.addEventListener('resize', tourReposition);
      requestAnimationFrame(() => requestAnimationFrame(() => showTourStep()));
    });
  }

  // =======================================================================
  // INIT
  // =======================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    initAuthScreen();
    initNav();
    initMonthBar();
    initFilters();
    initExpenseModal();
    initTxDetail();
    initConfirmModal();
    initSegmentNotice();
    initSharing();
    initWhatsNew();
    initProfile();
    initDatePicker();
    initAvatarModal();
    initNameModal();
    initManageCategories();
    initCategoryEditModal();
    initTour();
    try { await loadMeta(); } catch (_) { /* meta retries implicitly on next action */ }
    boot();
  });
})();
