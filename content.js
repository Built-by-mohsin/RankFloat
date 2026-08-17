(function () {
  'use strict';

  if (window.__positionTrackerInjected) return;
  window.__positionTrackerInjected = true;

  const STORAGE_KEYS = {
    CONFIG: 'config',
    RANK_HISTORY: 'rankHistory'
  };

  const WIDGET_ID = 'position-tracker-root';

  // ─── Utilities ───────────────────────────────────────────────────────────

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return formatDate(d);
  }

  function normalizeDomain(input) {
    if (!input) return '';
    let domain = input.trim().toLowerCase();
    domain = domain.replace(/^https?:\/\//, '');
    domain = domain.replace(/^www\./, '');
    domain = domain.split('/')[0].split('?')[0];
    return domain;
  }

  function domainMatches(url, targetDomain) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const target = normalizeDomain(targetDomain);
      return host === target || host.endsWith('.' + target);
    } catch {
      return false;
    }
  }

  function getSearchQuery() {
    return new URLSearchParams(window.location.search).get('q')?.trim() || '';
  }

  function keywordMatches(query, keywords) {
    const q = query.toLowerCase();
    return keywords.some((kw) => kw.toLowerCase() === q);
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }

  function findRankForDate(logs, targetDateStr) {
    if (!logs?.length) return null;

    const exact = logs.find((entry) => entry.date === targetDateStr);
    if (exact) return exact.rank;

    const targetTime = new Date(targetDateStr + 'T12:00:00').getTime();
    let closest = logs[0];
    let minDiff = Math.abs(new Date(closest.date + 'T12:00:00').getTime() - targetTime);

    for (const entry of logs) {
      const diff = Math.abs(new Date(entry.date + 'T12:00:00').getTime() - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = entry;
      }
    }

    return closest?.rank ?? null;
  }

  function extractRootDomain(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function rootDomainMatches(domain, targetDomain) {
    const d = normalizeDomain(domain);
    const t = normalizeDomain(targetDomain);
    return d === t || d.endsWith('.' + t) || t.endsWith('.' + d);
  }

  function collectOrganicEntries() {
    const seen = new Set();
    const entries = [];

    const processBlock = (block) => {
      if (block.closest('#tads, #tadsb, .commercial-unit, [data-text-ad]')) return;

      const titleLink =
        block.querySelector('a[href^="http"] h3')?.closest('a[href^="http"]') ||
        block.querySelector('h3')?.closest('a[href^="http"]') ||
        block.querySelector('a[href^="http"]:has(h3)');

      if (!titleLink) return;

      const href = titleLink.href;
      if (!href || seen.has(href)) return;
      if (/google\.(com|[a-z]{2,3})\//i.test(href) && !href.includes('/url?')) return;

      seen.add(href);
      entries.push({
        href,
        title: extractResultTitle(block),
        description: extractResultDescription(block),
        rootDomain: extractRootDomain(href)
      });
    };

    document.querySelectorAll('#search .g, #rso .g, #search div[data-hveid]').forEach(processBlock);

    if (entries.length === 0) {
      document.querySelectorAll('#search a[href^="http"], #rso a[href^="http"]').forEach((link) => {
        const hasTitle = link.querySelector('h3') || link.closest('h3');
        if (!hasTitle) return;
        const block = link.closest('.g, div[data-hveid], div[data-ved]') || link.parentElement?.parentElement;
        if (block) processBlock(block);
      });
    }

    return entries;
  }

  function extractResultTitle(block) {
    const h3 = block.querySelector('h3');
    return h3?.textContent?.trim() || '';
  }

  function extractResultDescription(block) {
    const selectors = [
      '.VwiC3b',
      '.IsZvec',
      '.st',
      '.MUxGbd',
      'div[data-sncf="1"]',
      '.aCOpRe',
      'div[style*="-webkit-line-clamp"]'
    ];

    for (const selector of selectors) {
      const el = block.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return text;
    }

    return '';
  }

  function collectOrganicLinks() {
    return collectOrganicEntries().map((entry) => entry.href);
  }

  function scrapeOrganicResults(targetDomain, entries = null) {
    const results = entries || collectOrganicEntries();
    const seenDomains = new Set();
    const topDomains = [];
    let rank = null;

    for (let i = 0; i < results.length; i++) {
      const href = results[i].href;

      if (rank == null && domainMatches(href, targetDomain)) {
        rank = i + 1;
      }

      const rootDomain = results[i].rootDomain || extractRootDomain(href);
      if (!rootDomain || seenDomains.has(rootDomain)) continue;

      seenDomains.add(rootDomain);
      topDomains.push(rootDomain);
      if (topDomains.length >= 10) break;
    }

    return { rank, topDomains };
  }

  // ─── SERP Gap Analysis ───────────────────────────────────────────────────

  const STOP_WORDS = new Set([
    'the', 'and', 'a', 'is', 'of', 'to', 'for', 'in', 'on', 'with', 'at', 'by',
    'an', 'your', 'our', 'my', 'from', 'that', 'this'
  ]);

  function tokenizeText(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
  }

  function detectSearchIntent(top3) {
    const titlesText = top3.map((r) => r.title.toLowerCase()).join(' ');

    if (/\b(best|top|vs)\b/.test(titlesText)) {
      return 'Intent: 🔍 Commercial Investigation';
    }
    if (/\b(how|guide|why|tutorial)\b/.test(titlesText)) {
      return 'Intent: 📘 Informational';
    }
    return 'Intent: 🟢 Transactional/General';
  }

  function analyzeSerpGap(top3, targetMeta) {
    const competitorTokens = [];
    top3.forEach((result) => {
      competitorTokens.push(...tokenizeText(result.title), ...tokenizeText(result.description));
    });

    const targetTokenSet = new Set([
      ...tokenizeText(targetMeta.title),
      ...tokenizeText(targetMeta.description)
    ]);

    const frequency = {};
    competitorTokens.forEach((word) => {
      frequency[word] = (frequency[word] || 0) + 1;
    });

    const missingWords = Object.entries(frequency)
      .filter(([word]) => !targetTokenSet.has(word))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => ({ word, count }));

    return {
      intent: detectSearchIntent(top3),
      missingWords,
      topCompetitor: top3[0] || { title: '', description: '' },
      targetMeta
    };
  }

  function scrapeSerpGapData(targetDomain, entries = null) {
    const results = entries || collectOrganicEntries();
    const top3 = results.slice(0, 3).map(({ title, description }) => ({ title, description }));

    let targetMeta = { title: '', description: '' };
    const searchLimit = Math.min(results.length, 100);

    for (let i = 0; i < searchLimit; i++) {
      if (domainMatches(results[i].href, targetDomain)) {
        targetMeta = {
          title: results[i].title,
          description: results[i].description
        };
        break;
      }
    }

    return analyzeSerpGap(top3, targetMeta);
  }

  async function saveTodayRank(keyword, rank) {
    const { rankHistory = {} } = await storageGet([STORAGE_KEYS.RANK_HISTORY]);
    const today = formatDate(new Date());
    const logs = rankHistory[keyword] || [];

    const existingIndex = logs.findIndex((entry) => entry.date === today);
    const entry = { date: today, rank: rank ?? null };

    if (existingIndex >= 0) {
      logs[existingIndex] = entry;
    } else {
      logs.push(entry);
    }

    logs.sort((a, b) => a.date.localeCompare(b.date));
    rankHistory[keyword] = logs;
    await storageSet({ [STORAGE_KEYS.RANK_HISTORY]: rankHistory });
    return logs;
  }

  async function injectTestData(keyword) {
    if (!keyword) return false;

    const { rankHistory = {} } = await storageGet([STORAGE_KEYS.RANK_HISTORY]);
    const logs = rankHistory[keyword] || [];
    const testEntries = [
      { date: daysAgo(7), rank: 12 },
      { date: daysAgo(15), rank: 25 }
    ];

    for (const entry of testEntries) {
      const existingIndex = logs.findIndex((log) => log.date === entry.date);
      if (existingIndex >= 0) {
        logs[existingIndex] = entry;
      } else {
        logs.push(entry);
      }
    }

    logs.sort((a, b) => a.date.localeCompare(b.date));
    rankHistory[keyword] = logs;
    await storageSet({ [STORAGE_KEYS.RANK_HISTORY]: rankHistory });
    return true;
  }

  // ─── Shadow DOM Widget ───────────────────────────────────────────────────

  function createStyles() {
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #e2e8f0;
      }

      .pt-widget {
        position: fixed;
        bottom: 20px;
        right: 30px;
        z-index: 2147483647;
        transition: width 0.25s ease, height 0.25s ease, border-radius 0.25s ease;
      }

      .pt-widget.collapsed {
        width: 48px;
        height: 48px;
      }

      .pt-widget.expanded {
        width: 400px;
      }

      .pt-shell {
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 14px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
        overflow: hidden;
        transition: border-radius 0.25s ease, box-shadow 0.25s ease;
      }

      .pt-widget.collapsed .pt-shell {
        border-radius: 50%;
        cursor: pointer;
      }

      .pt-widget.collapsed .pt-body,
      .pt-widget.collapsed .pt-header-title,
      .pt-widget.collapsed .pt-header-actions .pt-toggle-btn {
        display: none;
      }

      .pt-widget.expanded .pt-header-actions .pt-expand-btn {
        display: none;
      }

      .pt-widget.collapsed .pt-header {
        justify-content: center;
        padding: 0;
        height: 48px;
        border: none;
      }

      .pt-widget.collapsed .pt-icon-btn {
        width: 48px;
        height: 48px;
        border-radius: 50%;
      }

      .pt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid #1e293b;
        background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
      }

      .pt-header-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.02em;
        color: #f1f5f9;
      }

      .pt-logo {
        width: 18px;
        height: 18px;
        color: #38bdf8;
        flex-shrink: 0;
      }

      .pt-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .pt-icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .pt-icon-btn:hover {
        background: #1e293b;
        color: #f1f5f9;
      }

      .pt-body {
        padding: 16px;
      }

      .pt-setup-title {
        font-size: 15px;
        font-weight: 600;
        color: #f8fafc;
        margin-bottom: 4px;
      }

      .pt-setup-subtitle {
        font-size: 12px;
        color: #64748b;
        margin-bottom: 16px;
      }

      .pt-field {
        margin-bottom: 12px;
      }

      .pt-label {
        display: block;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        margin-bottom: 6px;
      }

      .pt-input {
        width: 100%;
        padding: 10px 12px;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 8px;
        color: #f1f5f9;
        font-size: 13px;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }

      .pt-input::placeholder { color: #475569; }

      .pt-input:focus {
        border-color: #38bdf8;
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
      }

      .pt-btn {
        width: 100%;
        padding: 10px 16px;
        margin-top: 4px;
        background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
        border: none;
        border-radius: 8px;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease, transform 0.1s ease;
      }

      .pt-btn:hover { opacity: 0.92; }
      .pt-btn:active { transform: scale(0.98); }

      .pt-metrics {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-bottom: 14px;
      }

      .pt-metric-card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 12px 8px;
        text-align: center;
        transition: border-color 0.2s ease, transform 0.2s ease;
      }

      .pt-metric-card:hover {
        border-color: #475569;
        transform: translateY(-1px);
      }

      .pt-metric-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #64748b;
        margin-bottom: 6px;
      }

      .pt-metric-value {
        font-size: 22px;
        font-weight: 700;
        color: #f8fafc;
        line-height: 1;
      }

      .pt-metric-value.rank-good { color: #4ade80; }
      .pt-metric-value.rank-mid { color: #fbbf24; }
      .pt-metric-value.rank-low { color: #f87171; }
      .pt-metric-value.rank-none { color: #475569; font-size: 16px; }

      .pt-info {
        background: #1e293b;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.5;
      }

      .pt-info strong { color: #e2e8f0; }

      .pt-info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .pt-info-row:last-child { margin-bottom: 0; }

      .pt-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        background: #0c4a6e;
        color: #7dd3fc;
      }

      .pt-footer {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid #1e293b;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .pt-test-btn {
        width: 100%;
        padding: 8px 16px;
        background: #334155;
        border: 1px dashed #64748b;
        border-radius: 8px;
        color: #cbd5e1;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }

      .pt-test-btn:hover {
        background: #475569;
        border-color: #94a3b8;
      }

      .pt-footer-actions {
        display: flex;
        justify-content: flex-end;
      }

      .pt-link-btn {
        background: none;
        border: none;
        color: #64748b;
        font-size: 11px;
        cursor: pointer;
        transition: color 0.15s ease;
      }

      .pt-link-btn:hover { color: #94a3b8; }

      .pt-error {
        font-size: 12px;
        color: #f87171;
        margin-top: 8px;
      }

      .pt-brand {
        text-align: center;
        padding: 10px 16px 12px;
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.06em;
        color: #475569;
        border-top: 1px solid #1e293b;
      }

      .pt-tabs {
        display: flex;
        gap: 3px;
        margin-bottom: 14px;
        background: #1e293b;
        padding: 4px;
        border-radius: 10px;
      }

      .pt-tab {
        flex: 1;
        padding: 7px 4px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: #64748b;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
      }

      .pt-tab:hover { color: #94a3b8; }

      .pt-tab.active {
        background: #0f172a;
        color: #f1f5f9;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
      }

      .pt-competitor-list {
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .pt-competitor-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 12px;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 8px;
        font-size: 12px;
        transition: border-color 0.15s ease, background 0.15s ease;
      }

      .pt-competitor-item.is-you {
        background: rgba(14, 165, 233, 0.12);
        border-color: rgba(56, 189, 248, 0.35);
      }

      .pt-competitor-rank {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        background: #334155;
        color: #94a3b8;
        font-size: 11px;
        font-weight: 700;
      }

      .pt-competitor-item.is-you .pt-competitor-rank {
        background: rgba(56, 189, 248, 0.2);
        color: #7dd3fc;
      }

      .pt-competitor-domain {
        flex: 1;
        color: #e2e8f0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pt-competitor-you {
        flex-shrink: 0;
        font-size: 10px;
        font-weight: 600;
        color: #4ade80;
      }

      .pt-competitor-empty {
        text-align: center;
        padding: 24px 12px;
        color: #64748b;
        font-size: 12px;
      }

      .pt-widget.minimal-badge {
        width: auto;
      }

      .pt-widget.minimal-badge.expanded {
        width: auto;
        max-width: 260px;
      }

      .pt-widget.minimal-badge .pt-header,
      .pt-widget.minimal-badge .pt-brand {
        display: none;
      }

      .pt-widget.minimal-badge .pt-body {
        padding: 12px 16px;
      }

      .pt-widget.minimal-badge .pt-shell {
        border-radius: 999px;
        cursor: pointer;
      }

      .pt-track-prompt {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 0;
        border: none;
        background: none;
        color: #e2e8f0;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: color 0.15s ease;
      }

      .pt-track-prompt:hover { color: #38bdf8; }

      .pt-track-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(56, 189, 248, 0.15);
        color: #38bdf8;
        font-size: 14px;
        line-height: 1;
      }

      .pt-gap-section {
        margin-bottom: 14px;
      }

      .pt-gap-section:last-child {
        margin-bottom: 0;
      }

      .pt-gap-section-title {
        font-size: 11px;
        font-weight: 600;
        color: #94a3b8;
        margin-bottom: 8px;
        letter-spacing: 0.02em;
      }

      .pt-gap-intent {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.12);
        border: 1px solid rgba(56, 189, 248, 0.25);
        color: #7dd3fc;
        font-size: 11px;
        font-weight: 600;
      }

      .pt-gap-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .pt-gap-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(251, 191, 36, 0.15);
        border: 1px solid rgba(251, 191, 36, 0.35);
        color: #fcd34d;
        font-size: 11px;
        font-weight: 600;
      }

      .pt-gap-pill-count {
        color: #fbbf24;
        font-weight: 700;
        opacity: 0.85;
      }

      .pt-gap-empty {
        font-size: 12px;
        color: #64748b;
        font-style: italic;
      }

      .pt-gap-accordion {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 10px;
        overflow: hidden;
      }

      .pt-gap-accordion summary {
        padding: 10px 12px;
        font-size: 11px;
        font-weight: 600;
        color: #cbd5e1;
        cursor: pointer;
        list-style: none;
        user-select: none;
        transition: background 0.15s ease;
      }

      .pt-gap-accordion summary::-webkit-details-marker {
        display: none;
      }

      .pt-gap-accordion summary:hover {
        background: #334155;
      }

      .pt-gap-accordion[open] summary {
        border-bottom: 1px solid #334155;
      }

      .pt-gap-meta {
        max-height: 160px;
        overflow-y: auto;
        padding: 10px 12px;
      }

      .pt-gap-meta-block {
        margin-bottom: 10px;
      }

      .pt-gap-meta-block:last-child {
        margin-bottom: 0;
      }

      .pt-gap-meta-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
        margin-bottom: 4px;
      }

      .pt-gap-meta-text {
        font-size: 12px;
        color: #e2e8f0;
        line-height: 1.5;
        word-break: break-word;
      }
    `;
    return style;
  }

  function rankClass(rank) {
    if (rank == null) return 'rank-none';
    if (rank <= 3) return 'rank-good';
    if (rank <= 10) return 'rank-mid';
    return 'rank-low';
  }

  function formatRank(rank) {
    return rank == null ? '—' : `#${rank}`;
  }

  function svgIcon(paths) {
    return `<svg class="pt-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }

  class PositionTrackerWidget {
    constructor() {
      this.collapsed = false;
      this.activeTab = 'history';
      this.host = null;
      this.shadow = null;
      this.root = null;
      this.config = null;
      this.serpGapData = null;
    }

    mount() {
      if (document.getElementById(WIDGET_ID)) return;

      this.host = document.createElement('div');
      this.host.id = WIDGET_ID;
      this.shadow = this.host.attachShadow({ mode: 'closed' });

      this.shadow.appendChild(createStyles());

      this.root = document.createElement('div');
      this.root.className = 'pt-widget expanded';
      this.root.innerHTML = this.buildShellHTML();
      this.shadow.appendChild(this.root);

      document.body.appendChild(this.host);

      this.bindEvents();
      this.render();
    }

    buildShellHTML() {
      return `
        <div class="pt-shell">
          <div class="pt-header">
            <div class="pt-header-title">
              ${svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>')}
              <span>Position Tracker</span>
            </div>
            <div class="pt-header-actions">
              <button class="pt-icon-btn pt-toggle-btn" type="button" title="Collapse" aria-label="Collapse widget">
                ${svgIcon('<polyline points="6 9 12 15 18 9"/>').replace('pt-logo', '')}
              </button>
              <button class="pt-icon-btn pt-expand-btn" type="button" title="Expand" aria-label="Expand widget">
                ${svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>').replace('pt-logo', '')}
              </button>
            </div>
          </div>
          <div class="pt-body"></div>
          <div class="pt-brand">Built by Mohsin</div>
        </div>
      `;
    }

    bindEvents() {
      const toggleBtn = this.root.querySelector('.pt-toggle-btn');
      const expandIcon = this.root.querySelector('.pt-expand-btn');
      const shell = this.root.querySelector('.pt-shell');

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setCollapsed(true);
      });

      expandIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.collapsed) this.setCollapsed(false);
      });

      shell.addEventListener('click', () => {
        if (this.collapsed) this.setCollapsed(false);
      });
    }

    setCollapsed(collapsed) {
      this.collapsed = collapsed;
      this.root.classList.toggle('collapsed', collapsed);
      this.root.classList.toggle('expanded', !collapsed);
    }

    async render() {
      const body = this.root.querySelector('.pt-body');
      const { config } = await storageGet([STORAGE_KEYS.CONFIG]);
      this.config = config;

      if (!config?.targetDomain || !config?.keywords?.length) {
        this.root.classList.remove('minimal-badge');
        body.innerHTML = this.renderSetup();
        this.bindSetupEvents();
        return;
      }

      const query = getSearchQuery();
      const isTracked = query && keywordMatches(query, config.keywords);

      if (query && !isTracked) {
        this.root.classList.add('minimal-badge');
        this.root.classList.remove('collapsed');
        this.root.classList.add('expanded');
        this.collapsed = false;
        body.innerHTML = this.renderTrackPrompt(query);
        this.bindTrackPromptEvents();
        return;
      }

      this.root.classList.remove('minimal-badge');
      body.innerHTML = await this.renderDashboard(config);
      this.bindDashboardEvents();
    }

    renderTrackPrompt(query) {
      return `
        <button class="pt-track-prompt" type="button" title="${this.escapeHtml(query)}">
          <span class="pt-track-icon">+</span>
          Click to track this keyword
        </button>
      `;
    }

    bindTrackPromptEvents() {
      const promptBtn = this.root.querySelector('.pt-track-prompt');

      promptBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const query = getSearchQuery();
        if (!query || !this.config) return;

        const keywords = [...this.config.keywords];
        if (!keywords.some((kw) => kw.toLowerCase() === query.toLowerCase())) {
          keywords.push(query);
        }

        await storageSet({
          [STORAGE_KEYS.CONFIG]: { ...this.config, keywords }
        });

        this.activeTab = 'history';
        await this.render();
      });
    }

    renderSetup() {
      return `
        <div class="pt-setup-title">Welcome aboard</div>
        <div class="pt-setup-subtitle">Configure your tracking to get started.</div>
        <form class="pt-setup-form">
          <div class="pt-field">
            <label class="pt-label" for="pt-domain">Target Domain</label>
            <input class="pt-input" id="pt-domain" type="text" placeholder="example.com" required />
          </div>
          <div class="pt-field">
            <label class="pt-label" for="pt-keywords">Keywords to Track</label>
            <input class="pt-input" id="pt-keywords" type="text" placeholder="seo tools, rank tracker, keyword research" required />
          </div>
          <button class="pt-btn" type="submit">Save & Start Tracking</button>
          <div class="pt-error" id="pt-setup-error" hidden></div>
        </form>
      `;
    }

    bindSetupEvents() {
      const form = this.root.querySelector('.pt-setup-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const domainInput = this.root.querySelector('#pt-domain');
        const keywordsInput = this.root.querySelector('#pt-keywords');
        const errorEl = this.root.querySelector('#pt-setup-error');

        const targetDomain = normalizeDomain(domainInput.value);
        const keywords = keywordsInput.value
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);

        if (!targetDomain) {
          errorEl.textContent = 'Please enter a valid domain.';
          errorEl.hidden = false;
          return;
        }

        if (!keywords.length) {
          errorEl.textContent = 'Please enter at least one keyword.';
          errorEl.hidden = false;
          return;
        }

        errorEl.hidden = true;
        await storageSet({
          [STORAGE_KEYS.CONFIG]: { targetDomain, keywords },
          [STORAGE_KEYS.RANK_HISTORY]: {}
        });

        await this.render();
      });
    }

    async renderDashboard(config) {
      const query = getSearchQuery();
      const isTracked = keywordMatches(query, config.keywords);
      const today = formatDate(new Date());
      const date7 = daysAgo(7);
      const date15 = daysAgo(15);

      let currentRank = null;
      let topDomains = [];
      let logs = [];

      if (isTracked && query) {
        const scrapeResult = scrapeOrganicResults(config.targetDomain);
        currentRank = scrapeResult.rank;
        topDomains = scrapeResult.topDomains;
        this.serpGapData = scrapeSerpGapData(config.targetDomain);
        logs = await saveTodayRank(query, currentRank);
      } else {
        const { rankHistory = {} } = await storageGet([STORAGE_KEYS.RANK_HISTORY]);
        if (query && rankHistory[query]) {
          logs = rankHistory[query];
        }
        if (query) {
          topDomains = scrapeOrganicResults(config.targetDomain).topDomains;
          this.serpGapData = scrapeSerpGapData(config.targetDomain);
        } else {
          this.serpGapData = null;
        }
      }

      const rankToday = isTracked ? currentRank : findRankForDate(logs, today);
      const rank7 = findRankForDate(logs, date7);
      const rank15 = findRankForDate(logs, date15);

      const statusMessage = !query
        ? 'No search query detected in the URL.'
        : isTracked
          ? `Tracking rank for <strong>"${this.escapeHtml(query)}"</strong>`
          : `Current search doesn't match tracked keywords.`;

      const historyPanel = this.renderHistoryPanel(rankToday, rank7, rank15);
      const competitorsPanel = this.renderCompetitorsPanel(topDomains, config.targetDomain);
      const serpGapPanel = this.renderSerpGapPanel(this.serpGapData);

      let activePanel = historyPanel;
      if (this.activeTab === 'competitors') activePanel = competitorsPanel;
      if (this.activeTab === 'serp-gap') activePanel = serpGapPanel;

      return `
        <div class="pt-tabs">
          <button class="pt-tab ${this.activeTab === 'history' ? 'active' : ''}" type="button" data-tab="history">My Rank History</button>
          <button class="pt-tab ${this.activeTab === 'competitors' ? 'active' : ''}" type="button" data-tab="competitors">Top 10 Competitors</button>
          <button class="pt-tab ${this.activeTab === 'serp-gap' ? 'active' : ''}" type="button" data-tab="serp-gap">SERP Gap</button>
        </div>
        <div class="pt-tab-panel">
          ${activePanel}
        </div>
        <div class="pt-info">
          <div class="pt-info-row">
            <span>Domain</span>
            <strong>${this.escapeHtml(config.targetDomain)}</strong>
          </div>
          <div class="pt-info-row">
            <span>Keywords</span>
            <span class="pt-badge">${config.keywords.length} tracked</span>
          </div>
          <div style="margin-top: 8px;">${statusMessage}</div>
        </div>
        <div class="pt-footer">
          <button class="pt-test-btn" type="button">Inject Test Data</button>
          <div class="pt-footer-actions">
            <button class="pt-link-btn pt-reset-btn" type="button">Reset configuration</button>
          </div>
        </div>
      `;
    }

    renderHistoryPanel(rankToday, rank7, rank15) {
      return `
        <div class="pt-metrics">
          <div class="pt-metric-card">
            <div class="pt-metric-label">Today</div>
            <div class="pt-metric-value ${rankClass(rankToday)}">${formatRank(rankToday)}</div>
          </div>
          <div class="pt-metric-card">
            <div class="pt-metric-label">7 Days Ago</div>
            <div class="pt-metric-value ${rankClass(rank7)}">${formatRank(rank7)}</div>
          </div>
          <div class="pt-metric-card">
            <div class="pt-metric-label">15 Days Ago</div>
            <div class="pt-metric-value ${rankClass(rank15)}">${formatRank(rank15)}</div>
          </div>
        </div>
      `;
    }

    renderCompetitorsPanel(topDomains, targetDomain) {
      if (!topDomains.length) {
        return `<div class="pt-competitor-empty">No organic results found on this page.</div>`;
      }

      const items = topDomains
        .map((domain, index) => {
          const isYou = rootDomainMatches(domain, targetDomain);
          return `
            <li class="pt-competitor-item${isYou ? ' is-you' : ''}">
              <span class="pt-competitor-rank">${index + 1}</span>
              <span class="pt-competitor-domain">${this.escapeHtml(domain)}</span>
              ${isYou ? '<span class="pt-competitor-you">(You)</span>' : ''}
            </li>
          `;
        })
        .join('');

      return `<ul class="pt-competitor-list">${items}</ul>`;
    }

    renderSerpGapPanel(gapData) {
      if (!gapData) {
        return `<div class="pt-competitor-empty">Run a tracked keyword search to analyze SERP gaps.</div>`;
      }

      const missingPills = gapData.missingWords.length
        ? gapData.missingWords
            .map(
              ({ word, count }) =>
                `<span class="pt-gap-pill">${this.escapeHtml(word)} <span class="pt-gap-pill-count">(${count}x)</span></span>`
            )
            .join('')
        : '<span class="pt-gap-empty">No significant keyword gaps detected — your copy aligns well with top results.</span>';

      const topTitle = gapData.topCompetitor.title || 'No title found';
      const topDescription = gapData.topCompetitor.description || 'No description found';

      return `
        <div class="pt-gap-section">
          <div class="pt-gap-section-title">🏷️ Search Intent Badge</div>
          <span class="pt-gap-intent">${this.escapeHtml(gapData.intent)}</span>
        </div>
        <div class="pt-gap-section">
          <div class="pt-gap-section-title">❌ Keywords You Missed</div>
          <div class="pt-gap-pills">${missingPills}</div>
        </div>
        <div class="pt-gap-section">
          <details class="pt-gap-accordion">
            <summary>📑 Meta Comparison Logs — #1 Ranked Competitor</summary>
            <div class="pt-gap-meta">
              <div class="pt-gap-meta-block">
                <div class="pt-gap-meta-label">Title</div>
                <div class="pt-gap-meta-text">${this.escapeHtml(topTitle)}</div>
              </div>
              <div class="pt-gap-meta-block">
                <div class="pt-gap-meta-label">Description</div>
                <div class="pt-gap-meta-text">${this.escapeHtml(topDescription)}</div>
              </div>
            </div>
          </details>
        </div>
      `;
    }

    bindDashboardEvents() {
      this.root.querySelectorAll('.pt-tab').forEach((tab) => {
        tab.addEventListener('click', async () => {
          this.activeTab = tab.dataset.tab;
          await this.render();
        });
      });

      const testBtn = this.root.querySelector('.pt-test-btn');
      if (testBtn) {
        testBtn.addEventListener('click', async () => {
          const query = getSearchQuery();
          if (!query) return;
          await injectTestData(query);
          await this.render();
        });
      }

      const resetBtn = this.root.querySelector('.pt-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
          await storageSet({
            [STORAGE_KEYS.CONFIG]: null,
            [STORAGE_KEYS.RANK_HISTORY]: {}
          });
          await this.render();
        });
      }
    }

    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────────

  function init() {
    const widget = new PositionTrackerWidget();
    widget.mount();

    const observer = new MutationObserver(() => {
      if (!document.getElementById(WIDGET_ID)) {
        widget.mount();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    let lastQuery = getSearchQuery();
    setInterval(() => {
      const currentQuery = getSearchQuery();
      if (currentQuery !== lastQuery) {
        lastQuery = currentQuery;
        widget.render();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
