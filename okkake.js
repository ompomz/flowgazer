/* =========================
 * okkake.js
 * 起点イベント・フォローリスト周辺の時系列タイムライン制御
 * ========================= */
(function () {
  'use strict';

  console.log('🚀 okkake.js loaded');

  const DEFAULT_RELAY = 'wss://r.kojira.io/';
  const TARGET_KINDS = [1, 1111];
  const NEWER_STEPS_SEC = [900, 1800, 3600];

  /* ---------- カスタム絵文字（通常リレー経由） ---------- */
  let cusemoLoadedKey = null;

  function ensureCustomEmojisLoaded() {
    const mgr = window.customEmojiManager;
    const auth = window.nostrAuth;
    if (!mgr || !auth?.pubkey || !auth.canWrite()) return;
    if (!relayManager.isConnected()) return;

    const key = `${auth.pubkey}@${relayManager.url}`;
    if (cusemoLoadedKey === key) return;

    if (cusemoLoadedKey && !cusemoLoadedKey.startsWith(`${auth.pubkey}@`)) {
      mgr.emojis.clear();
    }
    cusemoLoadedKey = key;
    mgr.fetchMyEmojis(auth.pubkey);
  }

  window.eventBus?.on(window.EVENTS?.AUTH_LOGIN_COMPLETED, ({ pubkey, onComplete }) => {
    console.log('📨 ログイン完了通知を受信:', pubkey.substring(0, 8) + '...');
    ensureCustomEmojisLoaded();
    onComplete?.();
  });

  window.eventBus?.on(window.EVENTS?.RELAY_CONNECTED, () => {
    ensureCustomEmojisLoaded();
  });

  /* ---------- 共通アクションメニュー ---------- */
  window.okkakeActionMenu = new NostrActionMenu({
    getRelayUrl: () => relayManager.url,
    publish: async (event) => await relayManager.publish(event)
  });

  /* ---------- DataStore ---------- */
  window.dataStore = {
    events: new Map(),
    profiles: new Map(),
    likedByMeIds: new Set(),

    addEvent(ev) {
      if (ev?.id && !this.events.has(ev.id)) {
        this.events.set(ev.id, ev);
      }
    },
    addProfile(pubkey, profile) {
      if (pubkey) {
        this.profiles.set(pubkey, profile);
      }
    },
    markAsLikedByMe(eventId) {
      if (eventId) {
        this.likedByMeIds.add(eventId);
      }
    },
    isLikedByMe(eventId) {
      return this.likedByMeIds.has(eventId);
    },
    clearTimelineData() {
      this.events.clear();
      this.likedByMeIds.clear();
    }
  };

  /* ---------- ProfileFetcher ---------- */
  function ProfileFetcher() {
    this.queue = new Set();
    this.inProgress = new Set();
    this.timer = null;
  }

  ProfileFetcher.prototype.request = function (pubkey) {
    if (!pubkey || dataStore.profiles.has(pubkey) || this.inProgress.has(pubkey)) return;

    this.queue.add(pubkey);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  };

  ProfileFetcher.prototype.flush = function () {
    if (this.queue.size === 0) return;
    if (!relayManager.isConnected()) return;

    const pubkeys = Array.from(this.queue);
    this.queue.clear();

    pubkeys.forEach((pk) => this.inProgress.add(pk));
    const subId = `profiles-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    relayManager.subscribe(subId, { kinds: [0], authors: pubkeys }, (type, ev) => {
      if (type === 'EVENT' && ev?.kind === 0) {
        if (window.NostrTools?.verifyEvent && !window.NostrTools.verifyEvent(ev)) return;
        try {
          const prev = dataStore.profiles.get(ev.pubkey);
          if (!prev || (prev._created_at || 0) < ev.created_at) {
            const profile = JSON.parse(ev.content);
            profile._created_at = ev.created_at;
            dataStore.addProfile(ev.pubkey, profile);
          }
        } catch (e) {
          console.error('❌ profile parse error', e);
        }
        this.inProgress.delete(ev.pubkey);
      }

      if (type === 'EOSE') {
        relayManager.unsubscribe(subId);
        pubkeys.forEach((pk) => this.inProgress.delete(pk));
        timeline.render();
      }
    });
  };

  window.profileFetcher = new ProfileFetcher();

  /* ---------- 入力解決（NIP-05 / NIP-19 / Hex） ---------- */
  async function resolveToHex(input) {
    if (!input) return null;
    const str = input.trim();
    const res = { hex: '', relays: [], pubkey: '' };

    if (str.includes('@')) {
      try {
        const profile = await Promise.race([
          NostrTools.nip05.queryProfile(str),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        if (profile?.pubkey) {
          res.hex = profile.pubkey;
          return res;
        }
      } catch (e) {
        console.warn('⚠️ NIP-05 解決に失敗:', e.message);
      }
    }

    if (/^(npub1|note1|nevent1|nprofile1)/.test(str)) {
      try {
        const decoded = NostrTools.nip19.decode(str);
        if (decoded.type === 'nprofile' || decoded.type === 'nevent') {
          res.hex = decoded.data.id || decoded.data.pubkey || '';
          res.relays = decoded.data.relays || [];
          res.pubkey = decoded.data.pubkey || '';
        } else {
          res.hex = decoded.data || '';
        }
        return res;
      } catch (e) {
        console.error('❌ NIP-19 decode error:', e);
      }
    }

    if (/^[0-9a-fA-F]{64}$/.test(str)) {
      res.hex = str;
      return res;
    }

    console.warn('⚠️ 解決に失敗しました（不正な形式）:', str);
    return null;
  }

  /* ---------- Timeline ---------- */
  function Timeline() {
    this.authors = [];
    this.oldest = null;
    this.newest = null;
    this.originId = null;
    this.originCreated = null;
    this.sortOrder = 'asc';
    this.measureCtx = null;
  }

  Timeline.prototype.loadOrigin = async function (pubkey, eventId, isAutoLoad) {
    dataStore.clearTimelineData();
    this.oldest = null;
    this.newest = null;

    const timelineEl = document.getElementById('timeline');
    if (timelineEl) timelineEl.innerHTML = '';

    const relayInputEl = document.getElementById('relay');
    if (!relayInputEl.value.trim()) {
      relayInputEl.value = DEFAULT_RELAY;
    }

    await relayManager.connect(relayInputEl.value.trim());

    let targetPubkey = pubkey;
    let origin = null;

    if (eventId) {
      origin = await this.fetchEvent(eventId);
      if (!origin) {
        alert('起点イベントが見つかりませんでした。リレーが正しいか確認してください。');
        return;
      }
      if (!targetPubkey) {
        targetPubkey = origin.pubkey;
        document.getElementById('pubkey').value = targetPubkey;
      }
    }

    if (!targetPubkey) {
      alert('作者(pubkey)を特定できませんでした。');
      return;
    }

    this.authors = await this.fetchContacts(targetPubkey);

    if (origin && TARGET_KINDS.includes(origin.kind)) {
      dataStore.addEvent(origin);
      profileFetcher.request(origin.pubkey);
    }

    if (origin) {
      this.originId = origin.id;
      this.originCreated = origin.created_at;
      this.oldest = origin.created_at;
      this.newest = origin.created_at;

      await this.fetchRange({
        since: isAutoLoad ? origin.created_at : origin.created_at - 300,
        until: origin.created_at + 300,
        limit: 100
      });
    }

    document.querySelector('.floating-btn-container')?.classList.add('is-visible');
    document.getElementById('share-link')?.classList.add('is-visible');
  };

  Timeline.prototype.fetchContacts = function (pubkey) {
    return new Promise((resolve) => {
      const subId = `k3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const list = [];
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        relayManager.unsubscribe(subId);
        if (list.length === 0) list.push(pubkey);
        resolve(list);
      };

      const timer = setTimeout(done, 3000);

      relayManager.subscribe(subId, { kinds: [3], authors: [pubkey] }, (type, ev) => {
        if (type === 'EVENT' && ev?.tags) {
          for (const tag of ev.tags) {
            if (tag[0] === 'p' && tag[1]) list.push(tag[1]);
          }
        }
        if (type === 'EOSE') done();
      });
    });
  };

  Timeline.prototype.fetchEvent = function (id) {
    return new Promise((resolve) => {
      const subId = `event-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let found = null;

      relayManager.subscribe(subId, { ids: [id] }, (type, ev) => {
        if (type === 'EVENT' && ev) {
          if (window.NostrTools?.verifyEvent && !window.NostrTools.verifyEvent(ev)) return;
          found = ev;
          relayManager.unsubscribe(subId);
          resolve(ev);
        }
        if (type === 'EOSE') {
          relayManager.unsubscribe(subId);
          if (!found) resolve(null);
        }
      });
    });
  };

  Timeline.prototype.fetchRange = function (filter, preserveMode = null) {
    return new Promise((resolve) => {
      const subId = `range-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let count = 0;
      const myPubkey = window.nostrAuth?.pubkey;
      const prevHeight = preserveMode ? document.documentElement.scrollHeight : 0;

      const filters = [
        {
          kinds: TARGET_KINDS,
          authors: this.authors,
          since: filter.since,
          until: filter.until,
          limit: filter.limit
        }
      ];

      if (myPubkey) {
        filters.push({
          kinds: [7],
          authors: [myPubkey],
          since: filter.since,
          until: filter.until,
          limit: filter.limit
        });
      }

      relayManager.subscribe(subId, filters, (type, ev) => {
        if (type === 'EVENT' && ev) {
          if (ev.kind === 7 && myPubkey && ev.pubkey === myPubkey) {
            const targetTag = ev.tags?.find((t) => t[0] === 'e' && t[1]);
            if (targetTag) dataStore.markAsLikedByMe(targetTag[1]);
          }

          if (TARGET_KINDS.includes(ev.kind)) {
            if (window.NostrTools?.verifyEvent && !window.NostrTools.verifyEvent(ev)) return;
            count++;
            dataStore.addEvent(ev);
            profileFetcher.request(ev.pubkey);

            if (this.oldest === null || ev.created_at < this.oldest) this.oldest = ev.created_at;
            if (this.newest === null || ev.created_at > this.newest) this.newest = ev.created_at;
          }
        }

        if (type === 'EOSE') {
          relayManager.unsubscribe(subId);
          this.render();

          if (preserveMode) {
            const diff = document.documentElement.scrollHeight - prevHeight;
            const growsAbove =
              (this.sortOrder === 'asc' && preserveMode === 'top') ||
              (this.sortOrder === 'desc' && preserveMode === 'bottom');
            if (diff > 0 && growsAbove) {
              window.scrollBy({ top: diff, left: 0, behavior: 'instant' });
            }
          }

          resolve(count);
        }
      });
    });
  };

Timeline.prototype.render = function () {
    const el = document.getElementById('timeline');
    if (!el) return;

    const prevScrollY = window.scrollY;
    const prevScrollHeight = document.documentElement.scrollHeight;

    // 画面の中央付近にある要素をアンカーにすると、端の要素よりズレにくくなる
    let anchorId = null;
    let anchorPrevTop = null;
    const targetY = window.innerHeight * 0.4;
    let bestDist = Infinity;

    for (const item of el.querySelectorAll('li.event[data-id]')) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(center - targetY);
      if (dist < bestDist) {
        bestDist = dist;
        anchorId = item.getAttribute('data-id');
        anchorPrevTop = rect.top;
      }
    }

    // 中身を空にするときに高さが一時的に縮んで scrollY が弾かれるのを防ぐ
    el.style.minHeight = `${el.offsetHeight}px`;
    el.innerHTML = '';

    if (!this.measureCtx) {
      const canvas = document.createElement('canvas');
      this.measureCtx = canvas.getContext('2d');
      this.measureCtx.font = '14px sans-serif';
    }
    const maxNameWidth = this.measureCtx.measureText('[00:00:00]').width;
    const isDark = document.body.classList.contains('dark-mode');
    const relayHint = relayManager.url ? [relayManager.url] : [];

    const events = Array.from(dataStore.events.values()).sort((a, b) =>
      this.sortOrder === 'asc' ? a.created_at - b.created_at : b.created_at - a.created_at
    );

    for (const ev of events) {
      const li = document.createElement('li');
      let className = 'event' + (ev.id === this.originId ? ' origin' : '');
      if (dataStore.isLikedByMe(ev.id)) className += ' event-liked';
      li.className = className;
      li.setAttribute('data-id', ev.id);
      li.setAttribute('data-pubkey', ev.pubkey);

      const prof = dataStore.profiles.get(ev.pubkey);
      const fullName = MyNostrUtils.getDisplayName(prof, ev.pubkey);
      const color = MyNostrUtils.getHslColor(ev.pubkey, isDark);

      let truncatedName = '';
      let currentWidth = 0;
      let isTruncated = false;
      for (const char of fullName) {
        const w = this.measureCtx.measureText(char).width;
        if (currentWidth + w > maxNameWidth) {
          isTruncated = true;
          break;
        }
        truncatedName += char;
        currentWidth += w;
      }
      const safeDisplayName = MyNostrUtils.escapeHtml(isTruncated ? `${truncatedName}…` : fullName);

      const timeStr = new Date(ev.created_at * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const nevent = NostrTools.nip19.neventEncode({ id: ev.id, relays: relayHint });
      const npub = NostrTools.nip19.npubEncode(ev.pubkey);

      const timeSpan = document.createElement('span');
      timeSpan.className = 'time';
      timeSpan.innerHTML =
        `<a href="https://ompomz.github.io/flowgazer/tweet?id=${nevent}" target="_blank" style="color: inherit; text-decoration: none;">` +
        `${ev.id === this.originId ? '▶ ' : ''}[${timeStr}]</a>`;

      const authorSpan = document.createElement('span');
      authorSpan.className = 'author';
      authorSpan.style.color = color;
      authorSpan.style.fontWeight = 'normal';
      authorSpan.innerHTML =
        `<a href="https://ompomz.github.io/flowgazer/tweet?id=${npub}" target="_blank" style="color: inherit; text-decoration: none;">` +
        `${safeDisplayName}</a>`;

      const separator = document.createElement('span');
      separator.className = 'separator';
      separator.textContent = ' > ';

      const contentSpan = document.createElement('span');
      contentSpan.className = 'post-content';
      contentSpan.innerHTML = MyNostrUtils.linkify(MyNostrUtils.escapeHtml(ev.content));

      li.appendChild(timeSpan);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(authorSpan);
      li.appendChild(separator);
      li.appendChild(contentSpan);

      window.okkakeActionMenu?.attach(li, ev);
      el.appendChild(li);
    }

    requestAnimationFrame(() => {
      el.style.minHeight = '';

      if (anchorId && anchorPrevTop !== null) {
        const nextAnchor = el.querySelector(`li.event[data-id="${CSS.escape(anchorId)}"]`);
        if (nextAnchor) {
          const deltaTop = nextAnchor.getBoundingClientRect().top - anchorPrevTop;
          if (Math.abs(deltaTop) > 1) {
            window.scrollBy({ top: deltaTop, left: 0, behavior: 'instant' });
          }
          document.dispatchEvent(new CustomEvent('timeline-rendered'));
          return;
        }
      }

      // アンカーが見つからない場合でも、高さ増分を補うフォールバック
      const heightDiff = document.documentElement.scrollHeight - prevScrollHeight;
      if (prevScrollY > 0 && heightDiff !== 0) {
        window.scrollTo({ top: Math.max(0, prevScrollY + Math.max(0, heightDiff)), left: 0, behavior: 'instant' });
      }

      document.dispatchEvent(new CustomEvent('timeline-rendered'));
    });
  };

  window.timeline = new Timeline();

  /* ---------- UI 初期化 ---------- */
  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('load');
    const eventIdInput = document.getElementById('eventId');
    const pubkeyInput = document.getElementById('pubkey');
    const relayInput = document.getElementById('relay');
    const themeToggle = document.getElementById('theme-toggle');

    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('id');
    const queryFollow = params.get('follow');
    let isAutoLoad = false;

    if (queryId) {
      eventIdInput.value = queryId;
      if (queryFollow) pubkeyInput.value = queryFollow;
      isAutoLoad = true;
      setTimeout(() => btn?.click(), 100);
    }

    if (btn) {
      btn.onclick = async function () {
        document.querySelector('.floating-btn-container')?.classList.remove('is-visible');
        document.getElementById('share-link')?.classList.remove('is-visible');

        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = '解決中...';

        try {
          const eventRes = await resolveToHex(eventIdInput.value);
          const pubkeyRes = await resolveToHex(pubkeyInput.value);

          let complemented = false;
          if (!relayInput.value.trim()) {
            const r = eventRes?.relays?.[0] || pubkeyRes?.relays?.[0];
            if (r) {
              relayInput.value = r;
              complemented = true;
            }
          }
          if (!pubkeyInput.value.trim() && eventRes?.pubkey) {
            pubkeyInput.value = eventRes.pubkey;
            complemented = true;
          }

          if (complemented) {
            if (isAutoLoad && !relayInput.value.trim()) {
              btn.textContent = 'リレーを入力してください';
              btn.style.backgroundColor = '#ffcc66';
              isAutoLoad = false;
              return;
            }
            if (!isAutoLoad) {
              btn.textContent = '補完しました！もういちどクリック';
              btn.style.backgroundColor = '#ffcc66';
              return;
            }
          }

          const finalPubkeyRes = await resolveToHex(pubkeyInput.value);
          const hexPubkey = finalPubkeyRes?.hex || '';
          const hexEventId = eventRes?.hex || '';

          if (!hexEventId) {
            alert('event ID を入力してください。');
            isAutoLoad = false;
            return;
          }

          btn.textContent = '読み込み中...';
          btn.style.backgroundColor = '';
          [pubkeyInput, eventIdInput, relayInput].forEach((el) => {
            if (el) el.style.backgroundColor = '';
          });

          if (isAutoLoad) {
            document.querySelector('.flex-container')?.classList.add('is-hidden');
          }

          await timeline.loadOrigin(hexPubkey, hexEventId, isAutoLoad);
        } catch (err) {
          alert('エラー: ' + err.message);
        } finally {
          btn.disabled = false;
          if (!btn.textContent.includes('もういちど')) {
            btn.textContent = prevText === '解決中...' ? '取得' : prevText;
          }
          isAutoLoad = false;
        }
      };
    }

    document.getElementById('older')?.addEventListener('click', () => {
      if (timeline.oldest === null) return;
      timeline.fetchRange({ until: timeline.oldest - 1, limit: 50 }, 'top');
    });

    document.getElementById('newer')?.addEventListener('click', async () => {
      const since = timeline.newest !== null ? timeline.newest + 1 : timeline.originCreated;
      if (since === null || since === undefined) return;
      for (const step of NEWER_STEPS_SEC) {
        if ((await timeline.fetchRange({ since, until: since + step }, 'bottom')) > 0) break;
      }
    });

    document.getElementById('go-to-origin')?.addEventListener('click', () => {
      const originEl = document.querySelector('.event.origin');
      if (originEl) {
        originEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        alert('起点イベントが見つかりません。');
      }
    });

    if (themeToggle && document.body.classList.contains('dark-mode')) {
      themeToggle.checked = true;
    }

    document.getElementById('share-link')?.addEventListener('click', async function () {
      const eventInput = eventIdInput.value.trim();
      if (!eventInput) {
        alert('起点となる event ID を入力してください。');
        return;
      }

      try {
        const evRes = await resolveToHex(eventInput);
        const pkRes = await resolveToHex(pubkeyInput.value);
        if (!evRes?.hex) {
          alert('有効な event ID を解決できませんでした。');
          return;
        }

        const newNevent = NostrTools.nip19.neventEncode({
          id: evRes.hex,
          relays: relayInput.value.trim()
            ? [relayInput.value.trim()]
            : (evRes.relays?.length ? [evRes.relays[0]] : []),
          author: evRes.pubkey || undefined
        });

        const url = new URL(window.location.href);
        url.search = '';
        url.searchParams.set('id', newNevent);
        if (pkRes?.hex && pkRes.hex !== evRes.pubkey) {
          url.searchParams.set('follow', NostrTools.nip19.npubEncode(pkRes.hex));
        }

        await navigator.clipboard.writeText(url.toString());
        const originalText = this.textContent;
        this.textContent = 'copied!';
        setTimeout(() => {
          this.textContent = originalText;
          this.style.backgroundColor = '';
        }, 2000);
      } catch (err) {
        console.error('Share error:', err);
        alert('リンクの生成に失敗しました。');
      }
    });

    const favInput = document.getElementById('kind-7-content-input');
    if (favInput) {
      const saved = localStorage.getItem('favMark');
      if (saved) favInput.value = saved;
      favInput.addEventListener('change', (e) => {
        const chars = Array.from(e.target.value);
        const singleChar = chars.length > 0 ? chars[0] : '+';
        localStorage.setItem('favMark', singleChar);
        e.target.value = singleChar;
      });
    }

    const kind7FixedToggle = document.getElementById('kind-7-fixed-toggle');
    const kind7ContentWrapper = document.getElementById('kind-7-content-wrapper');
    if (kind7FixedToggle) {
      const pickerAvailable = !!window.customEmojiManager?.openPicker;
      const saved = localStorage.getItem('kind7Mode') || 'fixed';
      const isFixed = saved !== 'picker' || !pickerAvailable;

      kind7FixedToggle.checked = isFixed;
      if (kind7ContentWrapper) kind7ContentWrapper.style.display = isFixed ? '' : 'none';
      if (!pickerAvailable) kind7FixedToggle.disabled = true;

      kind7FixedToggle.addEventListener('change', (e) => {
        localStorage.setItem('kind7Mode', e.target.checked ? 'fixed' : 'picker');
        if (kind7ContentWrapper) kind7ContentWrapper.style.display = e.target.checked ? '' : 'none';
      });
    }
  });
})();