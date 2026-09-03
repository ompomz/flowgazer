/* =========================
    グローバル状態・データ管理
   ========================= */

console.log("🚀 okkake.js loaded");

const DEFAULT_RELAY = "wss://r.kojira.io/"; // フォールバック用デフォルトリレー

window.eventBus.on(window.EVENTS.AUTH_LOGIN_COMPLETED, ({ pubkey, onComplete }) => {
  console.log('📨 ログイン完了通知を受信:', pubkey.substring(0, 8) + '...');
  onComplete();
});

window.okkakeActionMenu = new NostrActionMenu({
  // 必要に応じてオプション（リレー取得関数やクライアントタグなど）を指定
  getRelayUrl: function () { return relayManager.url; },
  publish: async function (event) {
    // リレーマネージャー経由でイベントを送信する処理など
    return await relayManager.publish(event);
  }
});

/* ---------- DataStore ---------- */
window.dataStore = {
  events: new Map(),
  profiles: new Map(),
  likedByMeIds: new Set(), // ★追加: 自分がふぁぼった投稿IDの管理用

  addEvent: function (ev) {
    if (!this.events.has(ev.id)) {
      this.events.set(ev.id, ev);
    }
  },

  addProfile: function (pubkey, profile) {
    this.profiles.set(pubkey, profile);
  },

  // ★追加: 自分がふぁぼったイベントとして登録
  markAsLikedByMe: function (eventId) {
    this.likedByMeIds.add(eventId);
  },

  // ★追加: ふぁぼ済みかチェック
  isLikedByMe: function (eventId) {
    return this.likedByMeIds.has(eventId);
  }
};

/* ---------- ProfileFetcher ---------- */
function ProfileFetcher() {
  this.queue = new Set();
  this.inProgress = new Set();
  this.timer = null;
}

ProfileFetcher.prototype.request = function (pubkey) {
  if (dataStore.profiles.has(pubkey)) return;
  if (this.inProgress.has(pubkey)) return;

  this.queue.add(pubkey);

  var self = this;
  clearTimeout(this.timer);
  this.timer = setTimeout(function () {
    self.flush();
  }, 300);
};

ProfileFetcher.prototype.flush = function () {
  if (this.queue.size === 0) return;

  var pubkeys = Array.from(this.queue);
  this.queue.clear();

  console.log("👤 Fetch profiles:", pubkeys.length);

  for (var i = 0; i < pubkeys.length; i++) {
    this.inProgress.add(pubkeys[i]);
  }

  var subId = "profiles-" + Date.now();
  var self = this;

  relayManager.subscribe(
    subId,
    { kinds: [0], authors: pubkeys },
    function (type, ev) {
      if (type === "EVENT") {
        try {
          var profile = JSON.parse(ev.content);
          dataStore.addProfile(ev.pubkey, profile);
          console.log("👤 profile loaded:", ev.pubkey);
        } catch (e) {
          console.error("❌ profile parse error", e);
        }
        self.inProgress.delete(ev.pubkey);
      }

      if (type === "EOSE") {
        relayManager.unsubscribe(subId);
        pubkeys.forEach(function (pk) {
          self.inProgress.delete(pk);
        });
        timeline.render();
      }
    }
  );
};

window.profileFetcher = new ProfileFetcher();

/* ---------- Utils ---------- */
async function resolveToHex(input) {
  if (!input) return null;
  const str = input.trim();
  const res = { hex: "", relays: [], pubkey: "" };

  // NIP-05 (最優先でチェック)
  if (str.includes("@")) {
    console.log("🔍 NIP-05 解決を試みます:", str);
    try {
      const profile = await Promise.race([
        NostrTools.nip05.queryProfile(str),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
      ]);

      if (profile && profile.pubkey) {
        console.log("✅ NIP-05 解決成功:", profile.pubkey);
        res.hex = profile.pubkey;
        return res;
      }
    } catch (e) {
      console.warn("⚠️ NIP-05 解決に失敗（タイポの可能性あり）:", e.message);
    }
  }

  // NIP-19 (npub, note, nevent, nprofile)
  if (str.startsWith("npub1") || str.startsWith("note1") ||
    str.startsWith("nevent1") || str.startsWith("nprofile1")) {
    try {
      const decoded = NostrTools.nip19.decode(str);
      if (decoded.type === 'nprofile' || decoded.type === 'nevent') {
        res.hex = decoded.data.id || decoded.data.pubkey;
        res.relays = decoded.data.relays || [];
        res.pubkey = decoded.data.pubkey || "";
      } else {
        res.hex = decoded.data;
      }
      return res;
    } catch (e) {
      console.error("❌ NIP-19 decode error:", e);
    }
  }

  // 最後：入力が「ちゃんとした Hex (64文字)」かチェック
  const hexPattern = /^[0-9a-fA-F]{64}$/;
  if (hexPattern.test(str)) {
    res.hex = str;
    return res;
  }

  console.warn("⚠️ 解決に失敗しました（不正な形式）:", str);
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
}

Timeline.prototype.loadOrigin = async function (pubkey, eventId, isAutoLoad) {
  console.log("▶ loadOrigin starting...", { pubkey, eventId, isAutoLoad });

  dataStore.events.clear();
  dataStore.likedByMeIds.clear(); // ★追加: 再ロード時にふぁぼ情報もクリア
  this.oldest = null;
  this.newest = null;
  document.getElementById("timeline").innerHTML = "";

  const relayInputEl = document.getElementById("relay");
  if (!relayInputEl.value.trim()) {
    console.warn("⚠️ リレーURL未指定のためデフォルトを使用します:", DEFAULT_RELAY);
    relayInputEl.value = DEFAULT_RELAY;
  }

  await relayManager.connect(relayInputEl.value.trim());

  let targetPubkey = pubkey;
  let origin = null;

  if (eventId) {
    console.log("🔍 起点イベントから情報を探します...");
    origin = await this.fetchEvent(eventId);

    if (origin) {
      if (!targetPubkey) {
        targetPubkey = origin.pubkey;
        console.log("✅ 作者を特定しました:", targetPubkey);
        const pkInput = document.getElementById("pubkey");
        pkInput.value = targetPubkey;
      }
    } else {
      alert("起点イベントが見つかりませんでした。リレーが正しいか確認してください。");
      return;
    }
  }

  if (!targetPubkey) {
    alert("作者(pubkey)を特定できませんでした。");
    return;
  }

  this.authors = await this.fetchContacts(targetPubkey);
  console.log("👥 followees:", this.authors.length);

  if (origin && origin.kind === 1) {
    dataStore.addEvent(origin);
    profileFetcher.request(origin.pubkey);
    console.log("📌 起点イベントを特例としてデータストアに登録しました");
  }

  this.originId = origin.id;
  this.originCreated = origin.created_at;
  this.oldest = origin.created_at;
  this.newest = origin.created_at;

  await this.fetchRange({
    since: isAutoLoad ? origin.created_at : origin.created_at - 300,
    until: origin.created_at + 300,
    limit: 100
  });

  document.querySelector(".floating-btn-container").classList.add("is-visible");
  document.getElementById("share-link").classList.add("is-visible");
};

Timeline.prototype.fetchContacts = function (pubkey) {
  var self = this;
  return new Promise(function (resolve) {
    var subId = "k3-" + Date.now();
    var list = [];

    var timer = setTimeout(function () {
      console.warn("⌛ Contact list request timed out for:", pubkey);
      relayManager.unsubscribe(subId);
      if (list.length === 0) list.push(pubkey);
      resolve(list);
    }, 3000);

    relayManager.subscribe(
      subId,
      { kinds: [3], authors: [pubkey] },
      function (type, ev) {
        if (type === "EVENT") {
          for (var i = 0; i < ev.tags.length; i++) {
            if (ev.tags[i][0] === "p") list.push(ev.tags[i][1]);
          }
        }

        if (type === "EOSE") {
          clearTimeout(timer);
          relayManager.unsubscribe(subId);
          if (list.length === 0) list.push(pubkey);
          console.log("✅ Contact list loaded:", list.length);
          resolve(list);
        }
      }
    );
  });
};

Timeline.prototype.fetchEvent = function (id) {
  return new Promise(function (resolve) {
    var subId = "event-" + Date.now();
    var found = null;

    relayManager.subscribe(
      subId,
      { ids: [id] },
      function (type, ev) {
        if (type === "EVENT") {
          found = ev;
          relayManager.unsubscribe(subId);
          resolve(ev);
        }
        if (type === "EOSE") {
          relayManager.unsubscribe(subId);
          if (!found) resolve(null);
        }
      }
    );
  });
};

Timeline.prototype.fetchRange = function (filter) {
  var self = this;
  return new Promise(function (resolve) {
    var subId = "range-" + Date.now();
    var count = 0;

    // ★修正: ログイン中の自分のpubkeyを取得（ROM専なら undefined）
    var myPubkey = window.nostrAuth?.pubkey;

    // ★修正: タイムライン用フィルター (Kind 1) と、自分が送ったふぁぼ用フィルター (Kind 7) を構築
    var filters = [
      {
        kinds: [1],
        authors: self.authors,
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

    relayManager.subscribe(
      subId,
      filters, // 複数フィルター配列を渡す
      function (type, ev) {
        if (type === "EVENT") {
          // ★追加: 自分が送った Kind 7 イベントならふぁぼ済みとして登録
          if (ev.kind === 7 && myPubkey && ev.pubkey === myPubkey) {
            var targetId = null;
            for (var t = 0; t < ev.tags.length; t++) {
              if (ev.tags[t][0] === 'e') {
                targetId = ev.tags[t][1];
                break;
              }
            }
            if (targetId) {
              dataStore.markAsLikedByMe(targetId);
            }
          }

          // Kind 1 の場合のみイベントとしてカウント・保存する
          if (ev.kind === 1) {
            count++;
            dataStore.addEvent(ev);
            profileFetcher.request(ev.pubkey);

            if (self.oldest === null || ev.created_at < self.oldest) self.oldest = ev.created_at;
            if (self.newest === null || ev.created_at > self.newest) self.newest = ev.created_at;
          }
        }

        if (type === "EOSE") {
          relayManager.unsubscribe(subId);
          self.render();
          resolve(count);
        }
      }
    );
  });
};

/* ---------- Timeline.prototype.render ---------- */
Timeline.prototype.render = function () {
  console.log("🖼 render timeline (Order: " + this.sortOrder + ")");
  var el = document.getElementById("timeline");
  el.innerHTML = "";

  if (!this.measureCtx) {
    const canvas = document.createElement('canvas');
    this.measureCtx = canvas.getContext('2d');
    this.measureCtx.font = "14px sans-serif";
  }
  const maxNameWidth = this.measureCtx.measureText("[00:00:00]").width;

  var events = Array.from(dataStore.events.values());

  events.sort(function (a, b) {
    if (this.sortOrder === 'asc') {
      return a.created_at - b.created_at;
    } else {
      return b.created_at - a.created_at;
    }
  }.bind(this));

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var li = document.createElement("li");

    // ★修正: 基本クラスに加え、自分がふぁぼった投稿なら event-liked を付与
    var className = "event" + (ev.id === this.originId ? " origin" : "");
    if (dataStore.isLikedByMe(ev.id)) {
      className += " event-liked";
    }
    li.className = className;

    li.setAttribute('data-id', ev.id);
    li.setAttribute('data-pubkey', ev.pubkey);

    const isDark = document.body.classList.contains('dark-mode');
    const prof = dataStore.profiles.get(ev.pubkey);
    const fullName = MyNostrUtils.getDisplayName(prof, ev.pubkey);
    const color = MyNostrUtils.getHslColor(ev.pubkey, isDark);

    let truncatedName = "";
    let currentWidth = 0;
    let isTruncated = false;

    for (const char of fullName) {
      const charWidth = this.measureCtx.measureText(char).width;
      if (currentWidth + charWidth > maxNameWidth) {
        isTruncated = true;
        break;
      }
      truncatedName += char;
      currentWidth += charWidth;
    }
    const finalDisplayName = isTruncated ? truncatedName + "…" : fullName;

    const timeStr = new Date(ev.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const nevent = NostrTools.nip19.neventEncode({
      id: ev.id,
      relays: [relayManager.url]
    });

    const timeSpan = document.createElement("span");
    timeSpan.className = "time";
    timeSpan.innerHTML = `<a href="https://ompomz.github.io/flowgazer/tweet?id=${nevent}" target="_blank" style="color: inherit; text-decoration: none;">${ev.id === this.originId ? "▶ " : ""}[${timeStr}]</a>`;

    const npub = NostrTools.nip19.npubEncode(ev.pubkey);
    const authorSpan = document.createElement("span");
    authorSpan.className = "author";
    authorSpan.style.color = color;
    authorSpan.style.fontWeight = "normal";
    authorSpan.innerHTML = `<a href="https://ompomz.github.io/flowgazer/tweet?id=${npub}" target="_blank" style="color: inherit; text-decoration: none;">${finalDisplayName}</a>`;

    const separator = document.createElement("span");
    separator.className = "separator";
    separator.textContent = " > ";

    const escapedContent = MyNostrUtils.escapeHtml(ev.content);
    const linkedContent = MyNostrUtils.linkify(escapedContent);
    const contentSpan = document.createElement("span");
    contentSpan.className = "post-content";
    contentSpan.innerHTML = linkedContent;

    li.appendChild(timeSpan);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(authorSpan);
    li.appendChild(separator);
    li.appendChild(contentSpan);

    if (window.okkakeActionMenu) {
      window.okkakeActionMenu.attach(li, ev);
    }

    el.appendChild(li);
  }

  document.dispatchEvent(new CustomEvent('timeline-rendered'));
};

Timeline.prototype.escapeHtml = function (str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, function (m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m];
  });
};

window.timeline = new Timeline();

/* ---------- UI Binding ---------- */
window.onload = async function () {
  const btn = document.getElementById("load");
  const eventIdInput = document.getElementById("eventId");
  const pubkeyInput = document.getElementById("pubkey");
  const relayInput = document.getElementById("relay");
  const themeToggle = document.getElementById('theme-toggle');

  const params = new URLSearchParams(window.location.search);
  const queryId = params.get('id');
  const queryFollow = params.get('follow');
  let isAutoLoad = false;

  if (queryId) {
    eventIdInput.value = queryId;

    if (queryFollow) {
      pubkeyInput.value = queryFollow;
      console.log("👥 Follow list source from URL:", queryFollow);
    }

    console.log("🔗 URL parameter found:", queryId);
    isAutoLoad = true;

    setTimeout(() => {
      btn.click();
    }, 100);
  }

  btn.onclick = async function () {
    document.querySelector(".floating-btn-container").classList.remove("is-visible");
    document.getElementById("share-link").classList.remove("is-visible");

    btn.disabled = true;
    btn.textContent = "解決中...";

    try {
      const eventRes = await resolveToHex(eventIdInput.value);
      const pubkeyRes = await resolveToHex(pubkeyInput.value);

      let complemented = false;

      if (!relayInput.value) {
        let r = null;
        if (eventRes && eventRes.relays?.length > 0) r = eventRes.relays[0];
        else if (pubkeyRes && pubkeyRes.relays?.length > 0) r = pubkeyRes.relays[0];

        if (r) {
          relayInput.value = r;
          complemented = true;
        }
      }

      if (!pubkeyInput.value && eventRes && eventRes.pubkey) {
        pubkeyInput.value = eventRes.pubkey;
        complemented = true;
      }

      if (complemented) {
        if (isAutoLoad && !relayInput.value) {
          btn.textContent = "リレーを入力してください";
          btn.style.backgroundColor = "#ffcc66";
          isAutoLoad = false;
          return;
        }

        if (!isAutoLoad) {
          btn.textContent = "補完しました！もういちどクリック";
          btn.style.backgroundColor = "#ffcc66";
          return;
        }
      }

      const finalPubkeyRes = await resolveToHex(pubkeyInput.value);
      const hexPubkey = finalPubkeyRes ? finalPubkeyRes.hex : "";
      const hexEventId = eventRes ? eventRes.hex : "";

      if (!hexEventId) {
        alert("event ID を入力してください。");
        isAutoLoad = false;
        return;
      }

      btn.textContent = "読み込み中...";
      btn.style.backgroundColor = "";
      [pubkeyInput, eventIdInput, relayInput].forEach(el => el.style.backgroundColor = "");

      if (isAutoLoad) {
        document.querySelector(".flex-container").classList.add("is-hidden");
      }

      await timeline.loadOrigin(hexPubkey, hexEventId, isAutoLoad);

    } catch (err) {
      alert("エラー: " + err.message);
    } finally {
      btn.disabled = false;
      if (!btn.textContent.includes("再度")) btn.textContent = "取得";
      isAutoLoad = false;
    }
  };

  document.getElementById("older").onclick = function () {
    timeline.fetchRange({ until: timeline.oldest - 1, limit: 50 });
  };

  document.getElementById("newer").onclick = async function () {
    const since = timeline.newest !== null ? timeline.newest + 1 : timeline.originCreated;
    for (let step of [900, 1800, 3600]) {
      if (await timeline.fetchRange({ since, until: since + step }) > 0) break;
    }
  };

  document.getElementById("go-to-origin").onclick = function () {
    const originEl = document.querySelector(".event.origin");
    if (originEl) {
      originEl.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      alert("起点イベントが見つかりません。");
    }
  };

  if (document.body.classList.contains('dark-mode')) {
    themeToggle.checked = true;
  }

  document.getElementById("share-link").onclick = async function () {
    const eventInput = document.getElementById("eventId").value;
    const relayInput = document.getElementById("relay").value;
    const pubkeyInput = document.getElementById("pubkey").value;

    if (!eventInput) {
      alert("起点となる event ID を入力してください。");
      return;
    }

    try {
      const evRes = await resolveToHex(eventInput);
      const pkRes = await resolveToHex(pubkeyInput);

      const newNevent = NostrTools.nip19.neventEncode({
        id: evRes.hex,
        relays: relayInput ? [relayInput] : (evRes.relays && evRes.relays.length > 0 ? [evRes.relays[0]] : []),
        author: evRes.pubkey
      });

      let shareUrl = window.location.origin + window.location.pathname + "?id=" + newNevent;

      if (pkRes && pkRes.hex && pkRes.hex !== evRes.pubkey) {
        const followNpub = NostrTools.nip19.npubEncode(pkRes.hex);
        shareUrl += "&follow=" + followNpub;
      }

      await navigator.clipboard.writeText(shareUrl);
      const btn = this;
      const originalText = btn.textContent;
      btn.textContent = "copied!";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.backgroundColor = "";
      }, 2000);

      console.log("🔗 Generated Share URL:", shareUrl);
    } catch (err) {
      console.error("Share error:", err);
      alert("リンクの生成に失敗しました。");
    }
  };

  // #kind-7-content-input の値を localStorage に同期する処理
  const favInput = document.getElementById('kind-7-content-input');
  if (favInput) {
    // 起動時に保存済みの値を反映
    const saved = localStorage.getItem('favMark');
    if (saved) favInput.value = saved;

    // 変更時にlocalStorageへ保存（NostrActionMenuの既定favMarkKey='favMark'と一致させる）
    favInput.addEventListener('change', (e) => {
      const chars = Array.from(e.target.value);
      const singleChar = chars.length > 0 ? chars[0] : '+';
      localStorage.setItem('favMark', singleChar);
      e.target.value = singleChar;
    });
  }
};