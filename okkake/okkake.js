/* =========================
    グローバル状態・データ管理
   ========================= */

console.log("🚀 okkake.js loaded");

/* ---------- DataStore ---------- */
window.dataStore = {
  events: new Map(),
  profiles: new Map(),

  addEvent: function (ev) {
    if (!this.events.has(ev.id)) {
      this.events.set(ev.id, ev);
    }
  },

  addProfile: function (pubkey, profile) {
    this.profiles.set(pubkey, profile);
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

  // NIP-05
  if (str.includes("@")) {
    try {
      const profile = await NostrTools.nip05.queryProfile(str);
      if (profile && profile.pubkey) { res.hex = profile.pubkey; return res; }
    } catch (e) { console.error("NIP-05 error:", e); }
  }

  // NIP-19 (npub, note, nevent, nprofile)
  if (str.startsWith("npub1") || str.startsWith("note1") ||
    str.startsWith("nevent1") || str.startsWith("nprofile1")) {
    try {
      const decoded = NostrTools.nip19.decode(str);
      if (decoded.type === 'nprofile' || decoded.type === 'nevent') {
        res.hex = decoded.data.id || decoded.data.pubkey;
        res.relays = decoded.data.relays || [];
        res.pubkey = decoded.data.pubkey || ""; // nevent用
      } else {
        res.hex = decoded.data; // npub, note用
      }
      return res;
    } catch (e) { console.error("NIP-19 error:", e); }
  }

  res.hex = str; // 素のHex
  return res;
}

/* ---------- Timeline ---------- */
function Timeline() {
  this.authors = [];
  this.oldest = null;
  this.newest = null;
  this.originId = null;
  this.originCreated = null;
  this.sortOrder = 'asc'; // ★初期状態を昇順に設定
}

Timeline.prototype.loadOrigin = async function (pubkey, eventId, isAutoLoad) {
  console.log("▶ loadOrigin starting...", { pubkey, eventId, isAutoLoad });

  dataStore.events.clear();
  this.oldest = null;
  this.newest = null;
  document.getElementById("timeline").innerHTML = "";

  // リレー接続（入力欄の値を優先）
  await relayManager.connect(document.getElementById("relay").value);

  // --- ★ここから追加・修正：pubkey自力解決ロジック ---
  let targetPubkey = pubkey;
  let origin = null;

  // もしeventIdはあるけどpubkeyが空、または不完全な場合
  if (eventId) {
    console.log("🔍 起点イベントから情報を探します...");
    origin = await this.fetchEvent(eventId);

    if (origin) {
      // イベントが見つかったら、そこから本当の作者(pubkey)を特定
      if (!targetPubkey) {
        targetPubkey = origin.pubkey;
        console.log("✅ 作者を特定しました:", targetPubkey);
        // 入力欄にも反映してあげると親切（案Aの演出も兼ねて）
        const pkInput = document.getElementById("pubkey");
        pkInput.value = targetPubkey;
      }
    } else {
      alert("起点イベントが見つかりませんでした。リレーが正しいか確認してください。");
      return;
    }
  }
  // --- ★ここまで ---

  if (!targetPubkey) {
    alert("作者(pubkey)を特定できませんでした。");
    return;
  }

  // 特定した作者のフォローリストを取得
  this.authors = await this.fetchContacts(targetPubkey);
  console.log("👥 followees:", this.authors.length);

  // 起点の情報をセット（fetchEventを2回やらないように工夫）
  this.originId = origin.id;
  this.originCreated = origin.created_at;
  this.oldest = origin.created_at;
  this.newest = origin.created_at;

  // 起点の前後を取得
  // isAutoLoad が true なら、since を origin.created_at（起点ちょうど）にする
  await this.fetchRange({
    since: isAutoLoad ? origin.created_at : origin.created_at - 300,
    until: origin.created_at + 300,
    limit: 100
  });

  document.querySelector(".floating-btn-container").classList.add("is-visible");
};

Timeline.prototype.fetchContacts = function (pubkey) {
  return new Promise(function (resolve) {
    var subId = "k3-" + Date.now();
    var list = [];

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
          relayManager.unsubscribe(subId);
          if (list.length === 0) list.push(pubkey);
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

    relayManager.subscribe(
      subId,
      {
        kinds: [1],
        authors: self.authors,
        since: filter.since,
        until: filter.until,
        limit: filter.limit
      },
      function (type, ev) {
        if (type === "EVENT") {
          count++;
          dataStore.addEvent(ev);
          profileFetcher.request(ev.pubkey);

          if (self.oldest === null || ev.created_at < self.oldest) self.oldest = ev.created_at;
          if (self.newest === null || ev.created_at > self.newest) self.newest = ev.created_at;
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

  var events = Array.from(dataStore.events.values());

  // 並び替えロジック
  events.sort(function (a, b) {
    if (this.sortOrder === 'asc') {
      return a.created_at - b.created_at; // 古い順
    } else {
      return b.created_at - a.created_at; // 新しい順
    }
  }.bind(this)); // thisを固定するために .bind(this) が必要です

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var li = document.createElement("li");
    li.className = "event" + (ev.id === this.originId ? " origin" : "");

    // sendfav.js 用のデータ属性
    li.setAttribute('data-id', ev.id);
    li.setAttribute('data-pubkey', ev.pubkey);

    // 1. ダークモードかどうか判定（色の明るさを自動調整するため）
    const isDark = document.body.classList.contains('dark-mode');

    // 2. プロフィール情報を取得
    const prof = dataStore.profiles.get(ev.pubkey);

    // 3. 【最強ポイント】名前解決と色生成を MyNostrUtils に任せる！
    const name = MyNostrUtils.getDisplayName(prof, ev.pubkey);
    const color = MyNostrUtils.getHslColor(ev.pubkey, isDark);
    const timeStr = new Date(ev.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // 1. まずは安全のためにHTMLエスケープする
    const escapedContent = MyNostrUtils.escapeHtml(ev.content);

    // 2. 【最強ポイント】エスケープ済みのテキスト内のURLをリンクや画像に変換！
    const linkedContent = MyNostrUtils.linkify(escapedContent);

    // 4. HTML組み立て（色を style="color: ..." で指定）
    li.innerHTML = `
  <span class="time">${ev.id === this.originId ? "▶ " : ""}[${timeStr}]</span> 
  <span class="author" style="color: ${color}; font-weight: normal;">${name}</span>
  <span class="separator">></span> 
  <span class="post-content">${linkedContent}</span>
  `;
    el.appendChild(li);
  }

  // sendfav.js へ通知
  document.dispatchEvent(new CustomEvent('timeline-rendered'));
};

// HTMLエスケープ用の補助関数（XSS対策）
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

  // --- URLパラメータ解析ロジック ---
  const params = new URLSearchParams(window.location.search);
  const queryId = params.get('id');
  let isAutoLoad = false; // 自動実行中フラグ

  if (queryId) {
    eventIdInput.value = queryId;
    console.log("🔗 URL parameter found:", queryId);
    isAutoLoad = true; // フラグを立てる

    // 少し待ってから自動クリック（DOMの準備を確実にするため）
    setTimeout(() => {
      btn.click();
    }, 100);
  }

  // 取得ボタンの処理
  btn.onclick = async function () {
    document.querySelector(".floating-btn-container").classList.remove("is-visible");

    btn.disabled = true;
    btn.textContent = "解決中...";

    try {
      // 1. まず入力を解析
      const eventRes = await resolveToHex(eventIdInput.value);
      const pubkeyRes = await resolveToHex(pubkeyInput.value);

      let complemented = false;

      // 【リレーの補完】
      if (!relayInput.value) {
        let r = null;
        if (eventRes && eventRes.relays?.length > 0) r = eventRes.relays[0];
        else if (pubkeyRes && pubkeyRes.relays?.length > 0) r = pubkeyRes.relays[0];

        if (r) {
          relayInput.value = r;
          complemented = true;
        }
      }

      // 【Pubkeyの補完】
      if (!pubkeyInput.value && eventRes && eventRes.pubkey) {
        pubkeyInput.value = eventRes.pubkey;
        complemented = true;
      }

      // --- 自動ロード時の判定ロジック ---
      if (complemented) {
        // 自動実行中であっても、リレーがまだ空なら入力を促す必要がある
        if (isAutoLoad && !relayInput.value) {
          btn.textContent = "リレーを入力してください";
          btn.style.backgroundColor = "#ffcc66";
          isAutoLoad = false; // ユーザー入力を待つため解除
          return;
        }

        // 手動操作（URLからではない）の場合は、確認のために一旦止める
        if (!isAutoLoad) {
          btn.textContent = "情報を抽出しました。再度 [取得] で開始";
          btn.style.backgroundColor = "#ffcc66";
          return;
        }

        // isAutoLoad が true で、かつリレーが埋まっているなら、止まらずに続行！
        console.log("🚀 Auto-loading with complemented info...");
      }

      // 2. 実際の取得
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

      // ★ここを追加：読み込みが確定したら入力エリアを隠す
      if (isAutoLoad) {
        document.querySelector(".flex-container").classList.add("is-hidden");
      }

      await timeline.loadOrigin(hexPubkey, hexEventId, isAutoLoad);

    } catch (err) {
      alert("エラー: " + err.message);
    } finally {
      btn.disabled = false;
      if (!btn.textContent.includes("再度")) btn.textContent = "取得";
      isAutoLoad = false; // 処理が終わったのでフラグを確実に下ろす
    }
  };

  // --- その他のボタン・イベント ---
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

  // テーマスイッチの状態合わせ
  if (document.body.classList.contains('dark-mode')) {
    themeToggle.checked = true;
  }
};