/**
 * Module de reconnaissance vocale fr-BE (Web Speech API)
 * + analyseur intelligent (en 1 phrase ou en plusieurs temps) pour EV en français / français de Belgique.
 */
(function (global) {
  'use strict';

  function normalizeFrenchNumbers(input, isOpenSession, hasExistingKm) {
    let s = String(input || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // Remplace d'abord "pour cent" / "pourcent" par "%" pour ne pas confondre "cent" avec 100
    s = s.replace(/\bpour\s*cents?\b/g, '%');

    // Convertit les nombres courants dictés en toutes lettres (français & belge)
    const wordMap = [
      [/\bquatre[\s-]vingt[\s-]dix[\s-]neuf\b/g, '99'],
      [/\bquatre[\s-]vingt[\s-]dix[\s-]huit\b/g, '98'],
      [/\bquatre[\s-]vingt[\s-]dix[\s-]sept\b/g, '97'],
      [/\bquatre[\s-]vingt[\s-]seize\b/g, '96'],
      [/\bquatre[\s-]vingt[\s-]quinze\b/g, '95'],
      [/\bquatre[\s-]vingt[\s-]quatorze\b/g, '94'],
      [/\bquatre[\s-]vingt[\s-]treize\b/g, '93'],
      [/\bquatre[\s-]vingt[\s-]douze\b/g, '92'],
      [/\bquatre[\s-]vingt[\s-]onze\b/g, '91'],
      [/\bquatre[\s-]vingt[\s-]dix\b/g, '90'],
      [/\bquatre[\s-]vingt[\s-]neuf\b/g, '89'],
      [/\bquatre[\s-]vingt[\s-]huit\b/g, '88'],
      [/\bquatre[\s-]vingt[\s-]sept\b/g, '87'],
      [/\bquatre[\s-]vingt[\s-]six\b/g, '86'],
      [/\bquatre[\s-]vingt[\s-]cinq\b/g, '85'],
      [/\bquatre[\s-]vingt[\s-]quatre\b/g, '84'],
      [/\bquatre[\s-]vingt[\s-]trois\b/g, '83'],
      [/\bquatre[\s-]vingt[\s-]deux\b/g, '82'],
      [/\bquatre[\s-]vingt[\s-]un\b/g, '81'],
      [/\bquatre[\s-]vingts?\b/g, '80'],
      [/\bnonante[\s-]neuf\b/g, '99'],
      [/\bnonante[\s-]huit\b/g, '98'],
      [/\bnonante[\s-]sept\b/g, '97'],
      [/\bnonante[\s-]six\b/g, '96'],
      [/\bnonante[\s-]cinq\b/g, '95'],
      [/\bnonante[\s-]quatre\b/g, '94'],
      [/\bnonante[\s-]trois\b/g, '93'],
      [/\bnonante[\s-]deux\b/g, '92'],
      [/\bnonante[\s-]+et[\s-]+un\b/g, '91'],
      [/\bnonante[\s-]un\b/g, '91'],
      [/\bnonante\b/g, '90'],
      [/\bhuitante[\s-]cinq\b/g, '85'],
      [/\bhuitante\b/g, '80'],
      [/\bseptante[\s-]neuf\b/g, '79'],
      [/\bseptante[\s-]huit\b/g, '78'],
      [/\bseptante[\s-]sept\b/g, '77'],
      [/\bseptante[\s-]six\b/g, '76'],
      [/\bseptante[\s-]cinq\b/g, '75'],
      [/\bseptante[\s-]quatre\b/g, '74'],
      [/\bseptante[\s-]trois\b/g, '73'],
      [/\bseptante[\s-]deux\b/g, '72'],
      [/\bseptante[\s-]+et[\s-]+un\b/g, '71'],
      [/\bseptante[\s-]un\b/g, '71'],
      [/\bseptante\b/g, '70'],
      [/\bsoixante[\s-]quinze\b/g, '75'],
      [/\bsoixante[\s-]dix\b/g, '70'],
      [/\bsoixante[\s-]cinq\b/g, '65'],
      [/\bsoixante\b/g, '60'],
      [/\bcinquante[\s-]cinq\b/g, '55'],
      [/\bcinquante\b/g, '50'],
      [/\bquarante[\s-]cinq\b/g, '45'],
      [/\bquarante\b/g, '40'],
      [/\btrente[\s-]cinq\b/g, '35'],
      [/\btrente\b/g, '30'],
      [/\bvingt[\s-]cinq\b/g, '25'],
      [/\bvingt\b/g, '20'],
      [/\bquinze\b/g, '15'],
      [/\bdix\b/g, '10'],
      [/\bcent\b/g, '100'],
      [/\bzero\b/g, '0']
    ];

    for (let i = 0; i < wordMap.length; i++) {
      s = s.replace(wordMap[i][0], wordMap[i][1]);
    }

    // 1. Milliers séparés par point ("16.985" -> "16985")
    s = s.replace(/\b(\d{1,3})\.(\d{3})\b/g, '$1$2');

    // 2. En début de charge uniquement (et si le km n'est pas déjà rempli),
    //    fusionne le premier millier séparé par espace ("32 120" -> "32120")
    //    seulement s'il n'y a pas déjà un kilométrage >= 1000 dans la phrase
    if (!isOpenSession && !hasExistingKm && !/\b\d{4,6}\b/.test(s)) {
      s = s.replace(/\b(\d{1,3})\s(\d{3})\b/, '$1$2');
    }
    return s;
  }

  function detectVoiceCommand(rawText) {
    const s = String(rawText || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (/^(effacer|recommencer|reprendre|corriger|vider)$/.test(s)) return 'reset';
    if (/^(stop|termine|fini|arreter|annuler)$/.test(s)) return 'stop';
    return null;
  }

  /**
   * Analyse une phrase dictée (complète ou incrémentale) et renvoie { km, pct, range, place, command }
   * existing (optionnel) : { km: boolean, pct: boolean, range: boolean } indique les champs déjà remplis
   */
  function parseFrenchVoice(rawText, isOpenSession, frequentPlaces, existing) {
    const ext = existing || { km: false, pct: false, range: false };
    const command = detectVoiceCommand(rawText);
    const text = normalizeFrenchNumbers(rawText, isOpenSession, Boolean(ext.km));
    const result = { km: null, pct: null, range: null, place: null, command: command };
    if (command) return result;

    const places = Array.isArray(frequentPlaces) ? frequentPlaces : [];

    // 1. Détection éventuelle d'un lieu de charge
    if (/\b(maison|home|domicile)\b/.test(text)) {
      result.place = { label: 'Home', country: 'Be' };
    } else {
      for (let i = 0; i < places.length; i++) {
        const p = places[i];
        const tokens = String(p.label || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/[\s-]+/)
          .filter(function (t) { return t.length >= 4; });
        if (tokens.some(function (t) { return text.indexOf(t) !== -1; })) {
          result.place = p;
          break;
        }
      }
    }

    // 2. Extraction de tous les nombres avec contexte avant/après
    const matches = [];
    const re = /(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      const before = text.slice(Math.max(0, m.index - 22), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 22);
      const isKmUnit = /^\s*(km|kilometre)/.test(after);
      const isPct = /^\s*(%|pour\s?cent)/.test(after) ||
        (/(batterie|charge|a)\s*$/.test(before) && num <= 100 && !isKmUnit);
      const isRange = /(autonomie|reste|restant)\s*$/.test(before);

      matches.push({ num, isPct, isRange, isKmUnit });
    }

    if (matches.length === 0) return result;

    if (isOpenSession) {
      // Fin de charge : % fin + autonomie fin
      // Si un seul nombre sans unité et que % est déjà rempli mais pas autonomie -> autonomie (même <= 100 km)
      if (matches.length === 1 && !matches[0].isPct && ext.pct && !ext.range) {
        result.range = matches[0].num;
        return result;
      }

      const pctItem = matches.find(function (x) { return x.isPct; }) ||
        (!ext.pct ? matches.find(function (x) { return x.num <= 100 && !x.isRange && !x.isKmUnit; }) : null);
      if (pctItem && pctItem.num <= 100) result.pct = pctItem.num;

      const remaining = matches.filter(function (x) { return x !== pctItem; });
      const rangeItem = remaining.find(function (x) { return x.isRange || x.isKmUnit; }) || remaining[0];
      if (rangeItem) result.range = rangeItem.num;
    } else {
      // Début de charge : Kilométrage + % début + autonomie début
      // Cas incrémental à 1 seul nombre sans unité explicite
      if (matches.length === 1 && !matches[0].isPct && !matches[0].isRange) {
        const only = matches[0];
        if (!ext.km && only.num >= 900) {
          result.km = only.num;
          return result;
        }
        if (ext.km && ext.pct && !ext.range && only.num < 900) {
          result.range = only.num;
          return result;
        }
        if (ext.km && !ext.pct && only.num <= 100 && !only.isKmUnit) {
          result.pct = only.num;
          return result;
        }
      }

      const kmItem = matches.find(function (x) { return x.num >= 900; }) ||
        (!ext.km && matches.length >= 3 ? matches[0] : null);
      if (kmItem) result.km = kmItem.num;

      const rem1 = matches.filter(function (x) { return x !== kmItem; });
      const pctItem = rem1.find(function (x) { return x.isPct; }) ||
        (!ext.pct ? rem1.find(function (x) { return x.num <= 100 && !x.isRange; }) : null);
      if (pctItem && pctItem.num <= 100) result.pct = pctItem.num;

      const rem2 = rem1.filter(function (x) { return x !== pctItem; });
      const rangeItem = rem2.find(function (x) { return x.isRange || x.isKmUnit; }) || rem2[0];
      if (rangeItem) result.range = rangeItem.num;
    }

    return result;
  }

  const VoiceAPI = {
    isSupported: function () {
      return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },
    normalizeFrenchNumbers: normalizeFrenchNumbers,
    detectVoiceCommand: detectVoiceCommand,
    parseFrenchVoice: parseFrenchVoice,
    createRecognizer: function (lang) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return null;
      const rec = new SR();
      rec.lang = lang || 'fr-BE';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      return rec;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VoiceAPI;
  } else {
    global.EChargeVoice = VoiceAPI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
