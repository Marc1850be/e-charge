/**
 * E-Charge PWA — Interface 1 main + dictée vocale fr-BE + synchro Google Sheets
 */
(function () {
  'use strict';

  const STORAGE_KEYS = {
    SETTINGS: 'echarge_settings_v1',
    CACHE: 'echarge_cache_v1',
    QUEUE: 'echarge_queue_v1',
    DRAFTS: 'echarge_drafts_v1'
  };

  const DEFAULT_SETTINGS = {
    apiUrl: '',
    pin: '',
    leftHanded: false,
    theme: 'auto', // auto | dark | light
    carNames: {
      peugeot: 'Peugeot e5008',
      merco: 'Mercedes GLB'
    }
  };

  const FALLBACK_DATA = {
    cars: {
      peugeot: {
        id: 'peugeot',
        name: 'Peugeot e5008',
        plate: '',
        sheetName: 'Voiture 1',
        avgRangePerPct: 3.9,
        lastKm: 0,
        nextRow: 5,
        openSession: null,
        recentlySkippedRow: null,
        frequentPlaces: [
          { label: 'Home', country: 'Be' }
        ],
        recentRows: []
      },
      merco: {
        id: 'merco',
        name: 'Mercedes GLB',
        plate: '',
        sheetName: 'Voiture 2',
        avgRangePerPct: 4.8,
        lastKm: 0,
        nextRow: 5,
        openSession: null,
        recentlySkippedRow: null,
        frequentPlaces: [
          { label: 'Home', country: 'Be' }
        ],
        recentRows: []
      }
    }
  };

  const state = {
    settings: loadJSON(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS),
    data: loadJSON(STORAGE_KEYS.CACHE, FALLBACK_DATA),
    queue: loadJSON(STORAGE_KEYS.QUEUE, []),
    drafts: loadJSON(STORAGE_KEYS.DRAFTS, {
      peugeot: emptyDraft(),
      merco: emptyDraft()
    }),
    activeCar: 'peugeot',
    activeField: 'pctEnd',
    busy: false,
    syncing: false,
    activeSheet: null, // null | 'voice' | 'meta' | 'history' | 'settings'
    voiceListening: false,
    voiceInterim: '',
    voiceError: '',
    lastTranscript: '',
    lastSyncAt: null
  };

  let recognizer = null;
  let toastTimer = null;

  function emptyDraft() {
    return { km: '', pctStart: '', rangeStart: '', pctEnd: '', rangeEnd: '', lieu: 'Home', pays: 'Be', comment: '' };
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredClone(fallback);
      return Object.assign(structuredClone(fallback), JSON.parse(raw));
    } catch (_) {
      return structuredClone(fallback);
    }
  }

  function saveStorage(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (_) {}
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    return n !== null && n !== undefined && n !== '' ? Number(n).toLocaleString('fr-BE') : '—';
  }

  function isConfigured() {
    return Boolean(state.settings.apiUrl && state.settings.apiUrl.trim().startsWith('https://'));
  }

  function getCar(carId) {
    const id = carId || state.activeCar;
    return state.data.cars[id];
  }

  function getCarDisplayName(carId) {
    return (state.settings.carNames && state.settings.carNames[carId]) || getCar(carId).name;
  }

  function getFieldsForMode(isCharging) {
    return isCharging ? ['pctEnd', 'rangeEnd'] : ['km', 'pctStart', 'rangeStart'];
  }

  function ensureValidActiveField() {
    const car = getCar();
    const valid = getFieldsForMode(Boolean(car.openSession));
    if (!valid.includes(state.activeField)) {
      state.activeField = valid[0];
    }
  }

  function applyTheme() {
    const t = state.settings.theme || 'auto';
    if (t === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
  }

  function showToast(msg, kind) {
    const el = document.getElementById('toast');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    const icon = kind === 'error' ? '⚠️' : (kind === 'warn' ? '⏳' : '✓');
    el.innerHTML = `<span>${icon}</span><span>${escapeHtml(msg)}</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // =========================================================================
  // MAGIC LINK CONFIG (?url=...&pin=...)
  // =========================================================================
  function checkMagicSetupParams() {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('url');
    const pin = params.get('pin');
    if (url && url.startsWith('https://')) {
      state.settings.apiUrl = url.trim();
      if (pin !== null) state.settings.pin = pin.trim();
      saveStorage(STORAGE_KEYS.SETTINGS, state.settings);
      // Nettoie l'URL pour ne pas laisser le PIN dans l'historique
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
      showToast('Configuration importée automatiquement !');
    }
  }

  // =========================================================================
  // API GOOGLE APPS SCRIPT + FILE HORS-LIGNE
  // =========================================================================
  async function apiGetStatus(silent) {
    if (!isConfigured()) return;
    state.syncing = true;
    render();
    try {
      const url = new URL(state.settings.apiUrl.trim());
      url.searchParams.set('action', 'status');
      url.searchParams.set('pin', state.settings.pin || '');
      const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Erreur API');
      state.data = json.data;
      state.lastSyncAt = new Date();
      saveStorage(STORAGE_KEYS.CACHE, state.data);
      if (!silent) showToast('Synchronisé avec Google Sheets');
    } catch (err) {
      if (!silent) showToast(err.message || 'Impossible de joindre Google Sheets', 'error');
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function apiPost(payload) {
    const body = Object.assign({}, payload, { pin: state.settings.pin || '' });
    const res = await fetch(state.settings.apiUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur serveur');
    return json;
  }

  function applyOptimisticLocal(payload) {
    const car = getCar(payload.carId);
    if (!car) return;

    if (payload.action === 'start') {
      const rowNum = car.nextRow;
      const entry = {
        row: rowNum,
        lieu: payload.lieu || 'Home',
        pays: payload.pays || 'Be',
        km: Number(payload.km),
        pctStart: Number(payload.pctStart),
        rangeStart: Number(payload.rangeStart),
        pctEnd: null,
        rangeEnd: null,
        comment: payload.comment || ''
      };
      car.lastKm = entry.km;
      car.openSession = entry;
      car.recentlySkippedRow = null;
      car.nextRow = rowNum + 1;
      car.recentRows = [entry].concat(car.recentRows || []).slice(0, 5);
    } else if (payload.action === 'finish') {
      if (car.openSession) {
        if (payload.pctEnd !== null && payload.pctEnd !== undefined) car.openSession.pctEnd = Number(payload.pctEnd);
        if (payload.rangeEnd !== null && payload.rangeEnd !== undefined) car.openSession.rangeEnd = Number(payload.rangeEnd);
        if (payload.comment) car.openSession.comment = payload.comment;
        const idx = (car.recentRows || []).findIndex(r => r.row === car.openSession.row);
        if (idx !== -1) car.recentRows[idx] = Object.assign({}, car.openSession);
        car.openSession = null;
        car.recentlySkippedRow = null;
      }
    } else if (payload.action === 'skipEnd') {
      if (car.openSession) {
        car.recentlySkippedRow = car.openSession.row;
        car.openSession = null;
      }
    } else if (payload.action === 'reopenSkipped') {
      if (car.recentlySkippedRow) {
        const prev = (car.recentRows || []).find(r => r.row === car.recentlySkippedRow);
        if (prev) {
          car.openSession = Object.assign({}, prev);
          car.recentlySkippedRow = null;
        }
      }
    }
    saveStorage(STORAGE_KEYS.CACHE, state.data);
  }

  async function sendOrQueueAction(payload, successMsg) {
    // Mode démo si aucune URL configurée
    if (!isConfigured()) {
      applyOptimisticLocal(payload);
      showToast(successMsg + ' (mode démo local)', 'warn');
      return true;
    }

    state.busy = true;
    render();
    try {
      const json = await apiPost(payload);
      if (json.data) {
        state.data = json.data;
        state.lastSyncAt = new Date();
        saveStorage(STORAGE_KEYS.CACHE, state.data);
      }
      showToast(successMsg);
      return true;
    } catch (err) {
      // Erreur métier (ex: PIN incorrect) -> ne pas mettre en file
      const msg = String(err && err.message || '');
      if (msg.includes('PIN') || msg.includes('invalide') || msg.includes('introuvable')) {
        showToast(msg, 'error');
        return false;
      }
      // Sinon perte réseau probable -> mise en file hors-ligne
      state.queue.push(Object.assign({}, payload, { queuedAt: Date.now() }));
      saveStorage(STORAGE_KEYS.QUEUE, state.queue);
      applyOptimisticLocal(payload);
      showToast('Hors-ligne : enregistré en attente de synchro', 'warn');
      return true;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function flushQueue() {
    if (!isConfigured() || !state.queue.length || state.syncing) return;
    state.syncing = true;
    render();
    let synced = 0;
    try {
      while (state.queue.length > 0) {
        const item = state.queue[0];
        const json = await apiPost(item);
        state.queue.shift();
        synced++;
        saveStorage(STORAGE_KEYS.QUEUE, state.queue);
        if (json.data) {
          state.data = json.data;
          state.lastSyncAt = new Date();
          saveStorage(STORAGE_KEYS.CACHE, state.data);
        }
      }
      if (synced > 0) showToast(`${synced} action(s) hors-ligne synchronisée(s) !`);
    } catch (err) {
      showToast('Synchro reportée : ' + (err.message || 'réseau indisponible'), 'warn');
    } finally {
      state.syncing = false;
      render();
    }
  }

  // =========================================================================
  // INTERACTIONS UTILISATEUR (1 MAIN)
  // =========================================================================
  function getValidation() {
    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const open = car.openSession;

    if (open) {
      const hasPct = draft.pctEnd !== '';
      const hasRange = draft.rangeEnd !== '';
      if (!hasPct && !hasRange) {
        return { ok: true, type: 'skip', msg: 'Laissez vide pour clôturer sans noter la fin et passer à une nouvelle charge.' };
      }
      const p = hasPct ? parseInt(draft.pctEnd, 10) : null;
      const r = hasRange ? parseInt(draft.rangeEnd, 10) : null;
      if (p !== null && (p > 100 || p < 0)) return { ok: false, type: 'error', msg: 'Le pourcentage doit être compris entre 0 et 100 %.' };
      if (p !== null && open.pctStart !== null && p < open.pctStart) {
        return { ok: true, type: 'warn', msg: `Attention : ${p} % est inférieur au début (${open.pctStart} %).` };
      }
      if (p !== null && r !== null && open.pctStart !== null && open.rangeStart !== null) {
        return { ok: true, type: 'ok', msg: `+${p - open.pctStart} % (+${r - open.rangeStart} km gagnés)` };
      }
      return { ok: true, type: 'partial', msg: 'Saisie partielle : seule la valeur saisie sera enregistrée.' };
    } else {
      const km = parseInt(draft.km, 10);
      const p = parseInt(draft.pctStart, 10);
      const r = parseInt(draft.rangeStart, 10);
      if (!draft.km || !draft.pctStart || !draft.rangeStart) return { ok: false, type: 'empty', msg: '' };
      if (p > 100 || p < 0) return { ok: false, type: 'error', msg: 'Le pourcentage doit être compris entre 0 et 100 %.' };
      if (car.lastKm && km < car.lastKm) {
        return { ok: true, type: 'warn', msg: `Attention : ${fmtNum(km)} km < dernier relevé (${fmtNum(car.lastKm)} km).` };
      }
      return { ok: true, type: 'ok', msg: car.lastKm ? `+${fmtNum(km - car.lastKm)} km depuis la dernière charge` : 'Prêt à enregistrer' };
    }
  }

  async function submitSession() {
    if (state.busy) return;
    haptic(18);
    const val = getValidation();
    if (!val.ok) {
      showToast(val.msg || 'Complétez les champs pour enregistrer', 'warn');
      return;
    }

    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const open = car.openSession;

    if (open) {
      if (val.type === 'skip') {
        const ok = await sendOrQueueAction(
          { action: 'skipEnd', carId: car.id, row: open.row },
          `Ligne ${open.row} clôturée sans fin · Prêt pour nouvelle charge`
        );
        if (ok) {
          state.activeField = 'km';
          state.lastTranscript = '';
          render();
        }
      } else {
        const pctEnd = draft.pctEnd !== '' ? parseInt(draft.pctEnd, 10) : null;
        const rangeEnd = draft.rangeEnd !== '' ? parseInt(draft.rangeEnd, 10) : null;
        const ok = await sendOrQueueAction(
          { action: 'finish', carId: car.id, row: open.row, pctEnd, rangeEnd, comment: draft.comment || '' },
          `Fin enregistrée (ligne ${open.row})`
        );
        if (ok) {
          draft.pctEnd = '';
          draft.rangeEnd = '';
          draft.comment = '';
          saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
          state.activeField = 'km';
          state.lastTranscript = '';
          render();
        }
      }
    } else {
      const ok = await sendOrQueueAction(
        {
          action: 'start',
          carId: car.id,
          km: parseInt(draft.km, 10),
          pctStart: parseInt(draft.pctStart, 10),
          rangeStart: parseInt(draft.rangeStart, 10),
          lieu: draft.lieu || 'Home',
          pays: draft.pays || 'Be',
          comment: draft.comment || ''
        },
        `Début enregistré (ligne ${car.nextRow})`
      );
      if (ok) {
        state.drafts[state.activeCar] = emptyDraft();
        saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
        state.activeField = 'pctEnd';
        state.lastTranscript = '';
        render();
      }
    }
  }

  async function reopenSkipped() {
    haptic(12);
    const car = getCar();
    if (!car.recentlySkippedRow) return;
    const ok = await sendOrQueueAction(
      { action: 'reopenSkipped', carId: car.id },
      `Retour sur la fin de charge (ligne ${car.recentlySkippedRow})`
    );
    if (ok) {
      state.activeField = 'pctEnd';
      render();
    }
  }

  function selectCar(carId) {
    haptic(10);
    state.activeCar = carId;
    state.lastTranscript = '';
    stopVoice();
    state.activeSheet = null;
    const car = getCar(carId);
    state.activeField = car.openSession ? 'pctEnd' : 'km';
    render();
  }

  function setActiveField(field) {
    haptic(8);
    state.activeField = field;
    render();
  }

  function pressKey(k) {
    haptic(8);
    const draft = state.drafts[state.activeCar];
    const f = state.activeField;
    let val = draft[f] || '';

    if (k === 'BACK') {
      val = val.slice(0, -1);
    } else if (k === 'NEXT') {
      const fields = getFieldsForMode(Boolean(getCar().openSession));
      const idx = fields.indexOf(f);
      if (idx < fields.length - 1) {
        state.activeField = fields[idx + 1];
      } else {
        submitSession();
        return;
      }
      render();
      return;
    } else {
      const maxLen = f === 'km' ? 6 : (f.startsWith('pct') ? 3 : 4);
      if (val.length < maxLen) {
        val = val === '0' ? k : val + k;
      }
    }
    draft[f] = val;
    saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
    render();
  }

  function applyQuickChip(type, amount) {
    haptic(10);
    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const f = state.activeField;
    if (type === 'set') {
      draft[f] = String(amount);
      if (f.startsWith('pct')) {
        const fields = getFieldsForMode(Boolean(car.openSession));
        const idx = fields.indexOf(f);
        if (idx < fields.length - 1) state.activeField = fields[idx + 1];
      }
    } else if (type === 'addKm') {
      const base = draft.km ? parseInt(draft.km, 10) : (car.lastKm || 0);
      draft.km = String(base + amount);
    }
    saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
    render();
  }

  // =========================================================================
  // RECONNAISSANCE VOCALE (1 tap = écoute directe fr-BE)
  // =========================================================================
  function openAndStartVoice() {
    haptic(16);
    if (state.voiceListening) {
      stopVoice();
      state.activeSheet = null;
      render();
      return;
    }
    state.activeSheet = 'voice';
    state.voiceInterim = '';
    state.voiceError = '';
    render();
    startVoice();
  }

  function startVoice() {
    if (!window.EChargeVoice || !window.EChargeVoice.isSupported()) {
      state.voiceError = 'Reconnaissance vocale non supportée sur ce navigateur (utilisez Chrome sur Android ou saisissez votre phrase ci-dessous).';
      state.voiceListening = false;
      render();
      return;
    }
    try {
      stopVoice();
      const rec = window.EChargeVoice.createRecognizer('fr-BE');
      state.voiceListening = true;
      state.voiceInterim = '';
      state.voiceError = '';
      render();

      rec.onresult = (event) => {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += t;
          else interim += t;
        }
        state.voiceInterim = interim || finalText;
        if (finalText.trim()) {
          state.voiceListening = false;
          applyVoiceText(finalText.trim());
        } else {
          renderSheet();
        }
      };

      rec.onerror = (e) => {
        state.voiceListening = false;
        const map = {
          'not-allowed': 'Autorisez l\'accès au micro dans Chrome pour utiliser la dictée vocale.',
          'no-speech': 'Aucune voix détectée — appuyez sur « Réessayer » et parlez près du micro.',
          'network': 'Réseau requis par le moteur vocal Google (vous pouvez saisir au pavé hors-ligne).'
        };
        state.voiceError = map[e.error] || ('Erreur micro : ' + e.error);
        render();
      };

      rec.onend = () => {
        state.voiceListening = false;
        render();
      };

      recognizer = rec;
      rec.start();
    } catch (err) {
      state.voiceListening = false;
      state.voiceError = 'Impossible de démarrer le micro : ' + (err.message || err);
      render();
    }
  }

  function stopVoice() {
    if (recognizer) {
      try { recognizer.stop(); } catch (_) {}
      recognizer = null;
    }
    state.voiceListening = false;
  }

  function applyVoiceText(transcript) {
    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const open = Boolean(car.openSession);
    const parsed = window.EChargeVoice.parseFrenchVoice(transcript, open, car.frequentPlaces);

    stopVoice();
    state.activeSheet = null;
    state.lastTranscript = transcript;

    let count = 0;
    if (open) {
      if (parsed.pct !== null && parsed.pct <= 100) { draft.pctEnd = String(parsed.pct); count++; }
      if (parsed.range !== null) { draft.rangeEnd = String(parsed.range); count++; }
    } else {
      if (parsed.km !== null) { draft.km = String(parsed.km); count++; }
      if (parsed.pct !== null && parsed.pct <= 100) { draft.pctStart = String(parsed.pct); count++; }
      if (parsed.range !== null) { draft.rangeStart = String(parsed.range); count++; }
      if (parsed.place) { draft.lieu = parsed.place.label; draft.pays = parsed.place.country; }
    }

    saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
    haptic(20);
    showToast(count > 0 ? `🎙️ ${count} champ(s) rempli(s) — vérifiez et validez` : 'Aucun chiffre détecté dans la phrase', count > 0 ? '' : 'warn');
    render();
  }

  // =========================================================================
  // MODALES (LIEU / COMMENTAIRE / HISTORIQUE / RÉGLAGES)
  // =========================================================================
  function openSheet(name) {
    haptic(8);
    if (state.voiceListening) stopVoice();
    state.activeSheet = name;
    render();
  }

  function closeSheet() {
    stopVoice();
    state.activeSheet = null;
    render();
  }

  function saveSettingsForm(e) {
    e.preventDefault();
    state.settings.apiUrl = document.getElementById('cfgUrl').value.trim();
    state.settings.pin = document.getElementById('cfgPin').value.trim();
    state.settings.leftHanded = document.getElementById('cfgLeftHand').checked;
    state.settings.theme = document.getElementById('cfgTheme').value;
    state.settings.carNames = {
      peugeot: document.getElementById('cfgNamePeugeot').value.trim() || 'Peugeot e5008',
      merco: document.getElementById('cfgNameMerco').value.trim() || 'Mercedes GLB'
    };
    saveStorage(STORAGE_KEYS.SETTINGS, state.settings);
    applyTheme();
    closeSheet();
    showToast('Réglages enregistrés');
    if (isConfigured()) {
      apiGetStatus(false);
    }
  }

  async function copyMagicLink() {
    const url = document.getElementById('cfgUrl').value.trim();
    const pin = document.getElementById('cfgPin').value.trim();
    if (!url) {
      showToast('Entrez d\'abord l\'URL Apps Script', 'warn');
      return;
    }
    const base = window.location.origin + window.location.pathname;
    const magic = `${base}?url=${encodeURIComponent(url)}&pin=${encodeURIComponent(pin)}`;
    try {
      await navigator.clipboard.writeText(magic);
      showToast('Lien de config rapide copié !');
    } catch (_) {
      prompt('Copiez ce lien pour configurer un autre appareil :', magic);
    }
  }

  function saveMetaForm(e) {
    e.preventDefault();
    const draft = state.drafts[state.activeCar];
    const customLieu = document.getElementById('metaLieu');
    const customPays = document.getElementById('metaPays');
    const commentInput = document.getElementById('metaComment');
    if (customLieu) draft.lieu = customLieu.value.trim() || 'Home';
    if (customPays) draft.pays = customPays.value.trim() || 'Be';
    if (commentInput) draft.comment = commentInput.value.trim();
    saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
    closeSheet();
    render();
  }

  function pickPlaceInSheet(label, country) {
    const draft = state.drafts[state.activeCar];
    draft.lieu = label;
    draft.pays = country;
    const lieuInput = document.getElementById('metaLieu');
    const paysInput = document.getElementById('metaPays');
    if (lieuInput) lieuInput.value = label;
    if (paysInput) paysInput.value = country;
    saveStorage(STORAGE_KEYS.DRAFTS, state.drafts);
    renderSheet();
  }

  // =========================================================================
  // RENDU UI
  // =========================================================================
  function render() {
    ensureValidActiveField();
    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const open = car.openSession;
    const val = getValidation();

    // 1. TOP ZONE
    const pctStart = open ? (open.pctStart || 0) : (parseInt(draft.pctStart, 10) || 0);
    const pctEnd = open ? (parseInt(draft.pctEnd, 10) || pctStart) : pctStart;
    const gainPct = open && draft.pctEnd && open.pctStart !== null ? Math.max(0, parseInt(draft.pctEnd, 10) - open.pctStart) : 0;

    let bannerHtml = '';
    if (!isConfigured()) {
      bannerHtml = `
        <div class="offline-banner">
          <span>Mode démo (non connecté à Google Sheets)</span>
          <button onclick="App.openSheet('settings')">Connecter</button>
        </div>
      `;
    } else if (state.queue.length > 0) {
      bannerHtml = `
        <div class="offline-banner">
          <span>⏳ ${state.queue.length} charge(s) en attente hors-ligne</span>
          <button onclick="App.flushQueue()">Synchro</button>
        </div>
      `;
    }

    document.getElementById('topZone').innerHTML = `
      <div class="top-bar">
        <div style="min-width:0">
          <div class="car-title">
            <span>${escapeHtml(getCarDisplayName(car.id))}</span>
            <span class="car-plate">${escapeHtml(car.plate)}</span>
          </div>
          <div class="car-sub tabular">
            ${open
              ? `Ligne ${open.row} · ${escapeHtml(open.lieu)} (${escapeHtml(open.pays)}) · ${fmtNum(open.km)} km`
              : `Dernier : ${fmtNum(car.lastKm)} km · Prochaine : ligne ${car.nextRow}`
            }
          </div>
        </div>
        <div class="top-actions">
          <button class="icon-btn" onclick="App.refresh()" title="Actualiser">${state.syncing ? '⏳' : '↻'}</button>
          <button class="icon-btn" onclick="App.openSheet('history')" title="Historique">📋</button>
          <button class="icon-btn" onclick="App.openSheet('settings')" title="Réglages">⚙️</button>
        </div>
      </div>

      <div class="battery-wrap">
        <div class="battery-labels tabular">
          <span>
            ${open
              ? `Début : <strong style="color:var(--text)">${open.pctStart !== null ? open.pctStart + ' %' : '—'}</strong> (${fmtNum(open.rangeStart)} km)`
              : `<span class="status-pill ready" style="padding:2px 8px"><span class="dot ready"></span>Prête à charger</span>`
            }
          </span>
          <span style="font-weight:700; color:${open ? 'var(--warning)' : 'var(--primary)'}">
            ${open
              ? (draft.pctEnd ? `→ ${draft.pctEnd} % (+${gainPct} %)` : '⚡ En charge')
              : (draft.pctStart ? `${draft.pctStart} %` : '')
            }
          </span>
        </div>
        <div class="battery-track">
          <div class="battery-fill-end" style="width:${Math.min(100, Math.max(0, pctEnd))}%"></div>
          <div class="battery-fill-start" style="width:${Math.min(100, Math.max(0, pctStart))}%; background:${open ? 'var(--warning)' : 'var(--primary)'}"></div>
        </div>
      </div>
      ${bannerHtml}
    `;

    // 2. UNDO SKIPPED + LOCATION / COMMENT PILLS
    const undoHtml = (!open && car.recentlySkippedRow) ? `
      <div class="undo-bar">
        <span>Ligne ${car.recentlySkippedRow} clôturée sans fin</span>
        <button onclick="App.reopenSkipped()">↩ Compléter</button>
      </div>
    ` : '';

    const metaHtml = open
      ? `
        <div class="meta-row">
          <button class="meta-pill" onclick="App.openSheet('meta')">
            <span>💬 ${draft.comment ? escapeHtml(draft.comment) : 'Ajouter un commentaire (optionnel)'}</span>
            <span class="edit-tag">${draft.comment ? 'Modifier' : '+'}</span>
          </button>
        </div>
      `
      : `
        <div class="meta-row">
          <button class="meta-pill" onclick="App.openSheet('meta')" style="flex:1.4">
            <span>📍 <strong>${escapeHtml(draft.lieu)}</strong> (${escapeHtml(draft.pays)})</span>
            <span class="edit-tag">Changer</span>
          </button>
          <button class="meta-pill" onclick="App.openSheet('meta')" style="flex:0.8">
            <span>💬 ${draft.comment ? escapeHtml(draft.comment) : 'Note'}</span>
          </button>
        </div>
      `;

    document.getElementById('metaArea').innerHTML = undoHtml + metaHtml;

    // 3. NUMERIC FIELDS
    const fieldsEl = document.getElementById('fieldsArea');
    if (open) {
      fieldsEl.innerHTML = `
        <div class="fields-grid">
          <button class="field-card ${state.activeField === 'pctEnd' ? 'active' : ''}" onclick="App.setActiveField('pctEnd')">
            <div class="field-label">% fin charge</div>
            <div class="field-value tabular">
              ${draft.pctEnd ? escapeHtml(draft.pctEnd) : '<span class="placeholder">80</span>'}<span class="field-unit">%</span>
            </div>
          </button>
          <button class="field-card ${state.activeField === 'rangeEnd' ? 'active' : ''}" onclick="App.setActiveField('rangeEnd')">
            <div class="field-label">Autonomie fin</div>
            <div class="field-value tabular">
              ${draft.rangeEnd ? escapeHtml(draft.rangeEnd) : '<span class="placeholder">320</span>'}<span class="field-unit">km</span>
            </div>
          </button>
        </div>
      `;
    } else {
      fieldsEl.innerHTML = `
        <button class="field-card km-row ${state.activeField === 'km' ? 'active' : ''}" onclick="App.setActiveField('km')">
          <div>
            <div class="field-label">Kilométrage compteur</div>
            <div class="field-value tabular">
              ${draft.km ? fmtNum(draft.km) : `<span class="placeholder">${fmtNum((car.lastKm || 0) + 45)}</span>`}<span class="field-unit">km</span>
            </div>
          </div>
          <span class="prev-km-badge tabular">Préc. ${fmtNum(car.lastKm)}</span>
        </button>
        <div class="fields-grid">
          <button class="field-card ${state.activeField === 'pctStart' ? 'active' : ''}" onclick="App.setActiveField('pctStart')">
            <div class="field-label">% début</div>
            <div class="field-value tabular">
              ${draft.pctStart ? escapeHtml(draft.pctStart) : '<span class="placeholder">40</span>'}<span class="field-unit">%</span>
            </div>
          </button>
          <button class="field-card ${state.activeField === 'rangeStart' ? 'active' : ''}" onclick="App.setActiveField('rangeStart')">
            <div class="field-label">Autonomie début</div>
            <div class="field-value tabular">
              ${draft.rangeStart ? escapeHtml(draft.rangeStart) : '<span class="placeholder">160</span>'}<span class="field-unit">km</span>
            </div>
          </button>
        </div>
      `;
    }

    // 4. VALIDATION + VOICE TRANSCRIPT BANNER
    const valEl = document.getElementById('validationBox');
    if (val.msg) {
      valEl.classList.remove('hidden');
      valEl.className = 'info-box ' + (val.type === 'ok' || val.type === 'warn' || val.type === 'error' ? val.type : '');
      valEl.textContent = val.msg;
    } else {
      valEl.classList.add('hidden');
    }

    const vbEl = document.getElementById('voiceBanner');
    if (state.lastTranscript) {
      vbEl.classList.remove('hidden');
      vbEl.innerHTML = `
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎙️ « ${escapeHtml(state.lastTranscript)} »</span>
        <button onclick="App.clearTranscript()">✕</button>
      `;
    } else {
      vbEl.classList.add('hidden');
    }

    // 5. CONTEXTUAL QUICK CHIPS
    const chipsEl = document.getElementById('quickChips');
    if (state.activeField === 'km') {
      chipsEl.innerHTML = [
        { label: `=${fmtNum(car.lastKm)}`, fn: `App.applyQuickChip('set', ${car.lastKm || 0})` },
        { label: '+10', fn: `App.applyQuickChip('addKm', 10)` },
        { label: '+25', fn: `App.applyQuickChip('addKm', 25)` },
        { label: '+50', fn: `App.applyQuickChip('addKm', 50)` },
        { label: '+100', fn: `App.applyQuickChip('addKm', 100)` }
      ].map(c => `<button class="chip-btn tabular" onclick="${c.fn}">${c.label}</button>`).join('');
    } else if (state.activeField === 'pctEnd') {
      chipsEl.innerHTML = [60, 70, 80, 90, 100].map(p =>
        `<button class="chip-btn tabular" onclick="App.applyQuickChip('set', ${p})">${p} %</button>`
      ).join('');
    } else if (state.activeField === 'pctStart') {
      chipsEl.innerHTML = [20, 30, 40, 50, 60].map(p =>
        `<button class="chip-btn tabular" onclick="App.applyQuickChip('set', ${p})">${p} %</button>`
      ).join('');
    } else {
      const refPct = parseInt(state.activeField === 'rangeEnd' ? draft.pctEnd : draft.pctStart, 10) || 50;
      const factor = car.avgRangePerPct || 4.2;
      const est = Math.round((refPct * factor) / 5) * 5;
      const opts = [Math.max(10, est - 25), est, est + 25];
      chipsEl.innerHTML = opts.map(km =>
        `<button class="chip-btn tabular" onclick="App.applyQuickChip('set', ${km})">~${km} km</button>`
      ).join('');
    }

    // 6. ONE-HANDED KEYPAD
    const fields = getFieldsForMode(Boolean(open));
    const isLastField = fields.indexOf(state.activeField) === fields.length - 1;
    const digits = ['1','2','3','4','5','6','7','8','9'];
    const bottomKeys = state.settings.leftHanded
      ? [
          { label: isLastField ? 'OK ✓' : 'Suiv. →', action: 'NEXT', cls: 'next-key' },
          { label: '0', action: '0', cls: '' },
          { label: '⌫', action: 'BACK', cls: '' }
        ]
      : [
          { label: '⌫', action: 'BACK', cls: '' },
          { label: '0', action: '0', cls: '' },
          { label: isLastField ? 'OK ✓' : 'Suiv. →', action: 'NEXT', cls: 'next-key' }
        ];

    document.getElementById('keypad').innerHTML =
      digits.map(d => `<button class="key tabular" onclick="App.pressKey('${d}')">${d}</button>`).join('') +
      bottomKeys.map(b => `<button class="key tabular ${b.cls}" onclick="App.pressKey('${b.action}')">${b.label}</button>`).join('');

    // 7. ACTION ROW (CTA + MIC)
    const actionRow = document.getElementById('actionRow');
    actionRow.className = 'action-row' + (state.settings.leftHanded ? ' left-handed' : '');

    const submitBtn = document.getElementById('btnSubmit');
    submitBtn.disabled = state.busy;
    if (state.busy) {
      submitBtn.className = 'btn-submit ready';
      submitBtn.textContent = '⏳ Enregistrement...';
    } else if (open && val.type === 'skip') {
      submitBtn.className = 'btn-submit skip';
      submitBtn.textContent = '⏭ Terminer sans fin → Nouvelle';
    } else if (val.ok) {
      submitBtn.className = 'btn-submit ready';
      submitBtn.textContent = open
        ? `✓ Terminer (L.${open.row}${val.type === 'partial' ? ' · partiel' : ''})`
        : `⚡ Démarrer (L.${car.nextRow})`;
    } else {
      submitBtn.className = 'btn-submit';
      submitBtn.textContent = open ? `✓ Terminer (L.${open.row})` : `⚡ Démarrer (L.${car.nextRow})`;
    }

    const micBtn = document.getElementById('btnMic');
    micBtn.className = 'btn-mic' + (state.voiceListening ? ' listening' : '');

    // 8. BOTTOM CAR TABS
    document.getElementById('bottomTabs').innerHTML = ['peugeot', 'merco'].map(cid => {
      const c = getCar(cid);
      const isSel = cid === state.activeCar;
      const isCharging = Boolean(c.openSession);
      return `
        <button class="car-tab ${isSel ? 'selected' : ''}" onclick="App.selectCar('${cid}')">
          <div style="min-width:0">
            <div class="car-tab-name">${escapeHtml(getCarDisplayName(cid))}</div>
            <div class="car-tab-state">${isCharging ? '⚡ En charge' : '✓ Prête'}</div>
          </div>
          <span class="dot ${isCharging ? 'charging' : 'ready'}"></span>
        </button>
      `;
    }).join('');

    renderSheet();
  }

  function renderSheet() {
    const backdrop = document.getElementById('sheetBackdrop');
    const sheet = document.getElementById('bottomSheet');
    if (!state.activeSheet) {
      backdrop.classList.add('hidden');
      sheet.innerHTML = '';
      return;
    }
    backdrop.classList.remove('hidden');
    const car = getCar();
    const draft = state.drafts[state.activeCar];
    const open = Boolean(car.openSession);

    if (state.activeSheet === 'voice') {
      sheet.innerHTML = `
        <div class="sheet-header">
          <div class="sheet-title">🎙️ ${state.voiceListening ? 'Écoute en cours (fr-BE)...' : 'Dictée vocale'}</div>
          <button class="btn-small" onclick="App.closeSheet()">Fermer</button>
        </div>
        <div class="info-box">
          ${open
            ? 'Ex. : <strong>« 80 pour cent, 315 kilomètres »</strong> ou <strong>« nonante %, 360 »</strong>'
            : 'Ex. : <strong>« 32 120 km, 42 %, 145 km »</strong> (+ nom de borne si hors maison)'
          }
        </div>
        ${state.voiceInterim ? `<div class="voice-banner"><span>🗣️ ${escapeHtml(state.voiceInterim)}</span></div>` : ''}
        ${state.voiceError ? `<div class="info-box warn">${escapeHtml(state.voiceError)}</div>` : ''}
        <button class="${state.voiceListening ? 'btn-danger-full' : 'btn-primary-full'}" onclick="${state.voiceListening ? 'App.stopVoice()' : 'App.startVoice()'}">
          ${state.voiceListening ? '⏹ Arrêter l\'écoute' : '🎙️ Réessayer avec le micro'}
        </button>
        <form onsubmit="event.preventDefault(); const v = document.getElementById('manualVoiceText').value.trim(); if (v) App.applyVoiceText(v);" style="display:flex;gap:6px">
          <input id="manualVoiceText" class="text-input" placeholder="Ou dicter via clavier Android..." />
          <button type="submit" class="btn-small" style="white-space:nowrap">OK</button>
        </form>
      `;
    } else if (state.activeSheet === 'meta') {
      const places = car.frequentPlaces || [{ label: 'Home', country: 'Be' }];
      const countries = ['Be', 'Fr', 'De', 'Nl', 'Lu'];
      sheet.innerHTML = `
        <div class="sheet-header">
          <div class="sheet-title">${open ? '💬 Commentaire (col. U)' : '📍 Lieu & Commentaire'}</div>
          <button class="btn-small" onclick="App.closeSheet()">Fermer</button>
        </div>
        <form onsubmit="App.saveMetaForm(event)" style="display:flex;flex-direction:column;gap:12px">
          ${open ? '' : `
            <div class="form-group">
              <label>Bornes fréquentes</label>
              <div class="place-grid">
                ${places.map(p => `
                  <button type="button" class="place-chip ${draft.lieu === p.label ? 'selected' : ''}" onclick="App.pickPlaceInSheet('${escapeHtml(p.label)}', '${escapeHtml(p.country)}')">
                    ${escapeHtml(p.label)} <span style="opacity:0.65">(${escapeHtml(p.country)})</span>
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="form-group">
              <label>Lieu personnalisé</label>
              <input id="metaLieu" class="text-input" value="${escapeHtml(draft.lieu)}" placeholder="Home, Fastned, Shell..." />
            </div>
            <div class="form-group">
              <label>Pays</label>
              <div class="place-grid">
                ${countries.map(c => `
                  <button type="button" class="place-chip ${draft.pays === c ? 'selected' : ''}" onclick="document.getElementById('metaPays').value='${c}'; App.pickPlaceInSheet(document.getElementById('metaLieu').value || 'Home', '${c}')">${c}</button>
                `).join('')}
              </div>
              <input id="metaPays" class="text-input" value="${escapeHtml(draft.pays)}" placeholder="Be" style="margin-top:4px" />
            </div>
          `}
          <div class="form-group">
            <label>Commentaire (optionnel · colonne U)</label>
            <input id="metaComment" class="text-input" value="${escapeHtml(draft.comment || '')}" placeholder="Ex. charge rapide 150 kW, pluie..." />
          </div>
          <button type="submit" class="btn-primary-full">Enregistrer</button>
        </form>
      `;
    } else if (state.activeSheet === 'history') {
      const rows = car.recentRows || [];
      sheet.innerHTML = `
        <div class="sheet-header">
          <div class="sheet-title">📋 Dernières charges — ${escapeHtml(getCarDisplayName(car.id))}</div>
          <button class="btn-small" onclick="App.closeSheet()">Fermer</button>
        </div>
        ${rows.length === 0 ? '<div class="info-box">Aucune charge enregistrée.</div>' : rows.map(r => `
          <div class="history-item tabular">
            <div class="history-top">
              <span>Ligne ${r.row} · ${fmtNum(r.km)} km</span>
              <span>${escapeHtml(r.lieu)} (${escapeHtml(r.pays)})</span>
            </div>
            <div class="history-sub">
              <span>Début : ${r.pctStart !== null ? r.pctStart + ' %' : '—'} (${fmtNum(r.rangeStart)} km)</span>
              <span>Fin : ${r.pctEnd !== null ? r.pctEnd + ' %' : '—'} (${fmtNum(r.rangeEnd)} km)</span>
            </div>
            ${r.comment ? `<div style="color:var(--primary)">💬 ${escapeHtml(r.comment)}</div>` : ''}
          </div>
        `).join('')}
      `;
    } else if (state.activeSheet === 'settings') {
      sheet.innerHTML = `
        <div class="sheet-header">
          <div class="sheet-title">⚙️ Réglages & Connexion Sheets</div>
          <button class="btn-small" onclick="App.closeSheet()">Fermer</button>
        </div>
        <form onsubmit="App.saveSettingsForm(event)" style="display:flex;flex-direction:column;gap:11px">
          <div class="form-group">
            <label>URL de l'Application Web Google Apps Script</label>
            <input id="cfgUrl" class="text-input" type="url" value="${escapeHtml(state.settings.apiUrl)}" placeholder="https://script.google.com/macros/s/.../exec" />
          </div>
          <div class="form-group">
            <label>Code PIN secret (identique à SECRET_PIN dans Code.gs)</label>
            <input id="cfgPin" class="text-input" type="password" value="${escapeHtml(state.settings.pin)}" placeholder="2026" />
          </div>
          <div class="fields-grid">
            <div class="form-group">
              <label>Nom voiture 1</label>
              <input id="cfgNamePeugeot" class="text-input" value="${escapeHtml(getCarDisplayName('peugeot'))}" />
            </div>
            <div class="form-group">
              <label>Nom voiture 2</label>
              <input id="cfgNameMerco" class="text-input" value="${escapeHtml(getCarDisplayName('merco'))}" />
            </div>
          </div>
          <div class="fields-grid">
            <div class="form-group">
              <label>Thème</label>
              <select id="cfgTheme" class="text-input">
                <option value="auto" ${state.settings.theme === 'auto' ? 'selected' : ''}>Automatique</option>
                <option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Sombre</option>
                <option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Clair</option>
              </select>
            </div>
            <div class="form-group" style="justify-content:flex-end">
              <label style="display:flex;align-items:center;gap:8px;padding:10px 8px;cursor:pointer;color:var(--text)">
                <input id="cfgLeftHand" type="checkbox" ${state.settings.leftHanded ? 'checked' : ''} />
                <span>Mode gaucher</span>
              </label>
            </div>
          </div>
          <button type="submit" class="btn-primary-full">Enregistrer et synchroniser</button>
          <button type="button" class="btn-small" style="width:100%;padding:10px" onclick="App.copyMagicLink()">
            🔗 Copier le lien de config rapide (pour autre téléphone)
          </button>
        </form>
      `;
    }
  }

  // Expose API pour gestionnaires onclick
  window.App = {
    selectCar,
    setActiveField,
    pressKey,
    applyQuickChip,
    submitSession,
    reopenSkipped,
    openAndStartVoice,
    startVoice,
    stopVoice,
    applyVoiceText,
    clearTranscript: () => { state.lastTranscript = ''; render(); },
    openSheet,
    closeSheet,
    saveSettingsForm,
    copyMagicLink,
    saveMetaForm,
    pickPlaceInSheet,
    flushQueue,
    refresh: () => {
      if (state.queue.length) flushQueue();
      else apiGetStatus(false);
    }
  };

  // Init
  window.addEventListener('online', () => {
    if (state.queue.length > 0) flushQueue();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  checkMagicSetupParams();
  applyTheme();
  render();
  if (isConfigured()) {
    if (state.queue.length > 0) flushQueue();
    else apiGetStatus(true);
  }
})();
