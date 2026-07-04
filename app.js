/**
 * app.js
 * 【責務】: アプリケーション制御、リレー接続、ユーザーアクション処理
 * Baseline方式対応版
 */

// ========================================
// SubscriptionBuilder
// 購読フィルタの構築ロジックを集約するクラス。
// appState (FlowgazerApp) と dataStore への参照を受け取り、
// フィルタオブジェクトを返すことだけを責務とする。
// ========================================

class SubscriptionBuilder {
  /**
   * @param {FlowgazerApp} appState - cursorSince / showKind42 / filterAuthors の参照元
   * @param {DataStore} dataStore
   */
  constructor(appState, dataStore) {
    this.appState = appState;
    this.dataStore = dataStore;
  }

  /**
   * Stream Phase 用フィルタ配列を構築する
   * @param {string|null} myPubkey
   * @returns {Object[]}
   */
  buildStreamPhaseFilters(myPubkey) {
    const { cursorSince, showKind42, filterAuthors } = this.appState;
    const filters = [];

    // === 1. グローバルフィルタ ===
    const globalFilter = {
      kinds: showKind42 ? [1, 6, 42] : [1, 6],
      since: cursorSince
    };
    if (filterAuthors && filterAuthors.length > 0) {
      globalFilter.authors = filterAuthors;
    }
    filters.push(globalFilter);

    // === 2. フォローしている人の投稿フィルタ ===
    if (this.dataStore.followingPubkeys.size > 0) {
      const followingAuthors = Array.from(this.dataStore.followingPubkeys);
      let filteredFollowing;

      if (myPubkey) {
        filteredFollowing = this.dataStore.isFollowing(myPubkey)
          ? followingAuthors
          : followingAuthors.filter(pk => pk !== myPubkey);
      } else {
        filteredFollowing = followingAuthors;
      }

      if (filteredFollowing.length > 0) {
        filters.push({
          kinds: showKind42 ? [1, 6, 42] : [1, 6],
          authors: filteredFollowing,
          since: cursorSince
        });
      }
    }

    // === 3. 自分宛のリアクション ===
    if (myPubkey) {
      filters.push({ kinds: [7], '#p': [myPubkey], since: cursorSince });
      filters.push({ kinds: [6], '#p': [myPubkey], since: cursorSince });
      filters.push({ kinds: [1], '#p': [myPubkey], since: cursorSince });

      const myPostIds = Array.from(this.dataStore.getEventIdsByAuthor(myPubkey));
      if (myPostIds.length > 0) {
        filters.push({
          kinds: [6, 7],
          '#e': myPostIds.slice(0, 100),
          since: cursorSince
        });
      }
    }

    // === 4. 自分の投稿専用フィルタ（myposts のリアルタイム更新）===
    if (myPubkey) {
      filters.push({
        kinds: [1, 42],
        authors: [myPubkey],
        since: cursorSince
      });
    }

    return filters;
  }

  /**
   * LoadMore Step1 用フィルタ（タブ主データを until 指定で取得）を構築する
   * @param {string} tab
   * @param {number} untilTimestamp
   * @param {string|null} myPubkey
   * @returns {Object|null} フィルタオブジェクト。対象外タブの場合は null
   */
  buildLoadMoreStep1Filter(tab, untilTimestamp, myPubkey) {
    // ===== チャンネルタブ（kind:42、channelId指定）=====
    if (window.viewState.isChannelTab(tab)) {
      const channelId = window.viewState.getChannelId(tab);
      return {
        kinds: [42],
        '#e': [channelId],
        until: untilTimestamp - 1,
        limit: 50
      };
    }

    // ===== 通常タブ（kind:1ベース）=====
    const filter = {
      kinds: [1],
      until: untilTimestamp - 1,
      limit: 50
    };

    switch (tab) {
      case 'global':
        if (this.appState.filterAuthors?.length > 0) {
          filter.authors = this.appState.filterAuthors;
        }
        break;

      case 'following': {
        if (this.dataStore.followingPubkeys.size === 0) {
          console.warn('フォローリストが空です');
          return null;
        }
        const followingAuthors = Array.from(this.dataStore.followingPubkeys);
        filter.authors = myPubkey && !this.dataStore.isFollowing(myPubkey)
          ? followingAuthors.filter(pk => pk !== myPubkey)
          : followingAuthors;
        break;
      }

      case 'myposts':
        if (!myPubkey) return null;
        filter.authors = [myPubkey];
        break;

      case 'likes':
        if (!myPubkey) return null;
        filter.kinds = [1, 6, 7];
        filter['#p'] = [myPubkey];
        break;

      default:
        return null;
    }

    return filter;
  }

  /**
   * LoadMore Step2 用フィルタ（kind:6, 42 の補完取得）を構築する
   * チャンネルタブ・likes タブは Step2 不要のため null を返す
   * @param {string} tab
   * @param {number} untilTimestamp
   * @param {number} sinceTimestamp
   * @param {string|null} myPubkey
   * @returns {Object|null}
   */
  buildLoadMoreStep2Filter(tab, untilTimestamp, sinceTimestamp, myPubkey) {
    if (window.viewState.isChannelTab(tab)) return null;
    if (tab === 'likes') return null;

    const { showKind42, filterAuthors } = this.appState;
    const filter = {
      kinds: showKind42 ? [6, 42] : [6],
      until: untilTimestamp - 1,
      since: sinceTimestamp
    };

    switch (tab) {
      case 'global':
        if (filterAuthors?.length > 0) {
          filter.authors = filterAuthors;
        }
        break;

      case 'following': {
        if (this.dataStore.followingPubkeys.size === 0) return null;
        const followingAuthors = Array.from(this.dataStore.followingPubkeys);
        filter.authors = myPubkey && !this.dataStore.isFollowing(myPubkey)
          ? followingAuthors.filter(pk => pk !== myPubkey)
          : followingAuthors;
        break;
      }

      case 'myposts':
        if (!myPubkey) return null;
        filter.authors = [myPubkey];
        break;

      default:
        return null;
    }

    return filter;
  }
}

class FlowgazerApp {
  constructor() {
    // ===== アプリケーション状態 =====
    this.currentTab = 'global';
    this.isAutoUpdate = true;
    this.filterAuthors = null;
    this.flowgazerOnly = false;
    this.forbiddenWords = [];
    this.lastActiveTime = Date.now();
    this.activeChannelId = null; // 現在表示中のchannelId

    // kind:42（チャンネル投稿）の表示フラグ。
    // localStorage から復元することで、リロード後も設定が維持される。
    // view-state.js の _applyFilters にはオプションとして都度渡す。
    this.showKind42 = localStorage.getItem('showKind42') === 'true';

    // ===== データ取得済みフラグ =====
    this.tabDataFetched = {
      global: false,
      following: false,
      myposts: false,
      likes: false
    };

    // ===== Baseline方式用 =====
    this.isInitializing = false;
    this.cursorSince = Math.floor(Date.now() / 1000) - 300; // 300秒（5分）× 1 = 300

    // ===== 再接続リカバリ用 =====
    // 初回接続（init の await connectRelay）と再接続を区別するフラグ
    this._initialConnectionDone = false;

    // ===== 購読フィルタ構築 =====
    // DataStoreはこの時点で window.dataStore として確定しているが、
    // init() 先頭で明示的に代入して依存を明確にする
    this.subscriptionBuilder = null;
  }

  // ========================================
  // 初期化
  // ========================================

  async init() {
    console.log('🚀 flowgazer起動中...');

    // SubscriptionBuilder を初期化（DataStore が確定してから）
    this.subscriptionBuilder = new SubscriptionBuilder(this, window.dataStore);

    // ViewState に描画コールバックを注入する。
    // ViewState は timeline.js / app.js を直接知らないため、
    // 両者を知っている app.js がここで橋渡しする。
    window.viewState.setRenderCallbacks(
      // onScheduleRender: isAutoUpdate が ON のときだけ timeline.refresh() を呼ぶ
      () => {
        if (this.isAutoUpdate && window.timeline) {
          window.timeline.refresh();
        }
      },
      // onRenderNow: 常に即時 refresh（force=true で isAutoUpdate を無視）
      () => {
        if (window.timeline) {
          window.timeline.refresh(true);
        }
      }
    );

    // EventBusハンドラを最初に登録する（他の初期化より前に受け取れるようにするため）
    this._setupEventBusHandlers();

    // DOMが存在する状態でイベントリスナーを先に登録
    this.setupEventListeners();

    // ログインUI更新
    this.updateLoginUI();
    this.updateTabVisibility();

    // リレー接続
    const savedRelay = localStorage.getItem('relayUrl');
    const defaultRelay = 'wss://r.kojira.io/';
    const relay = savedRelay || defaultRelay;
    await this.connectRelay(relay);

    // キャッシュ済みチャンネルリストを復元（ログイン不要）
    const savedChannels = localStorage.getItem('myChannels');
    if (savedChannels) {
      try {
        this._updateChannelDropdown(JSON.parse(savedChannels));
        console.log('📁 保存されたチャンネルリストを復元しました');
      } catch (e) {
        console.error('❌ チャンネル復元失敗:', e);
      }
    }

    // 禁止ワード取得（全員共通）
    await this.fetchForbiddenWords();

    // Baseline方式でタイムライン初期化（全員共通）
    await this.initializeTimelineBaseline();

    // ログイン済みならログイン後処理を実行
    if (window.nostrAuth.isLoggedIn()) {
      await this.onLogin();
    }

    console.log('✅ flowgazer起動完了');
  }

  // ========================================
  // EventBusハンドラ登録
  // ========================================

  /**
   * EventBus経由で受け取るイベントのハンドラを登録する。
   * init() の先頭で呼ぶ。
   *
   * 登録するイベント:
   *   AUTH_LOGIN_COMPLETED  - ログイン操作完了 → onAuthSuccessFromUI() を呼ぶ
   *   RELAY_CONNECTED       - リレー接続成功 → 現状はログのみ（将来の再接続リカバリ用）
   */
  _setupEventBusHandlers() {
    // ---- AUTH_LOGIN_COMPLETED ----
    // auth-ui.js が emit し、app.js が受け取る。
    // payload.onComplete を呼ぶことで auth-ui.js 側の await が解除され、モーダルが閉じる。
    window.eventBus.on(window.EVENTS.AUTH_LOGIN_COMPLETED, async ({ pubkey, onComplete }) => {
      console.log('📨 [EventBus] auth:login-completed 受信', pubkey.substring(0, 8) + '...');
      try {
        await this.onAuthSuccessFromUI();
      } finally {
        // 成功・失敗どちらでも必ず onComplete を呼び、モーダルのローディングを解除する
        onComplete();
      }
    });

    // ---- RELAY_CONNECTED ----
    // relay-manager.js が emit し、app.js が受け取る。
    // 初回接続は init() の await connectRelay() が制御するため、
    // 2回目以降（予期しない切断からの再接続）のみリカバリを実行する。
    window.eventBus.on(window.EVENTS.RELAY_CONNECTED, ({ url }) => {
      console.log('📨 [EventBus] relay:connected 受信', url);

      if (this._initialConnectionDone) {
        // 再接続検知 → Anchor Phase + Stream Phase を再起動してタイムラインを復元
        console.log('🔄 再接続検知 → タイムラインリカバリ開始');
        this.initializeTimelineBaseline();
      }

      // 初回接続フラグを立てる（次回から再接続として扱う）
      this._initialConnectionDone = true;
    });

    console.log('✅ EventBusハンドラ登録完了');
  }

  // ========================================
  // ログイン後初期化（リロード時）
  // ========================================

  /**
   * リロード時のログイン後初期化。
   * init() から呼ばれる（ログイン操作後は EventBus 経由で onAuthSuccessFromUI が呼ばれる）。
   *
   * 【なぜ onAuthSuccessFromUI と2系統あるか】
   * - onLogin（リロード時）: kind:3 取得を非同期で裏側に走らせる設計。
   *   ページ表示を妨げないため fetchInitialData() 内で購読コールバックとして処理する。
   * - onAuthSuccessFromUI（ログイン操作後）: kind:3 取得の完了を await してからモーダルを閉じる設計。
   *   ユーザーがログインボタンを押したあと、フォロータブが即座に表示されることを保証するため。
   *
   * 2系統を統合するには「表示を妨げない」要件と「完了を待つ」要件を
   * 同時に満たす仕組みが必要で、現時点では意図的に分けている。
   */
  async onLogin() {
    const myPubkey = window.nostrAuth.pubkey;
    if (!myPubkey) {
      console.warn('⚠️ onLogin: pubkey が未確定のため処理をスキップします');
      return;
    }

    console.log('🔑 onLogin: ログイン後初期化開始 (リロード)', myPubkey.substring(0, 8) + '...');

    this.updateLoginUI();

    // タブのデータ取得済みフラグをリセット
    this.tabDataFetched.following = false;
    this.tabDataFetched.myposts   = false;
    this.tabDataFetched.likes     = false;

    // フォローリスト取得 → 確定後に Stream Phase 再起動（fetchInitialData内で行う）
    this.fetchInitialData();

    this.fetchMyChannels();
  }

  // ========================================
  // ログイン操作後の初期化（auth-ui.js から呼ばれる）
  // ========================================

  /**
   * auth-ui.js の onAuthSuccess から呼ばれるログイン後処理。
   *
   * 【onLogin との違い】
   * ・onLogin        → リロード時。kind:3取得はfetchInitialData内で非同期に行う。
   * ・onAuthSuccessFromUI → ログイン操作後。呼び出し元（auth-ui.js）が
   *   kind:3取得の完了を await してからこのメソッドを呼ぶため、
   *   フォローリストはすでにDataStoreに反映済みの状態で受け取る。
   *
   * このメソッドの責務:
   * - タブフラグのリセット
   * - StreamPhaseの再起動（フォローリスト反映済みの状態で）
   * - followingタブの初期表示構築
   * - チャンネルリスト取得
   * - UI更新
   *
   * @returns {Promise<void>}
   */
  async onAuthSuccessFromUI() {
    const myPubkey = window.nostrAuth.pubkey;
    if (!myPubkey) {
      console.warn('⚠️ onAuthSuccessFromUI: pubkey が未確定のためスキップ');
      return;
    }

    console.log('🔑 onAuthSuccessFromUI: ログイン後処理開始', myPubkey.substring(0, 8) + '...');

    // ---- kind:3 取得 → DataStore に反映 ----
    // auth-ui.js はこのメソッドが完了するまで await するため、
    // kind:3 取得完了（またはタイムアウト）後にモーダルが閉じられる。
    await this._fetchAndApplyFollowList(myPubkey);

    // タブのデータ取得済みフラグをリセット
    this.tabDataFetched.following = false;
    this.tabDataFetched.myposts   = false;
    this.tabDataFetched.likes     = false;

    // StreamPhase を フォローリスト反映済みの状態で再起動
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();

    // following タブ初期表示を構築（遡及登録 → 必要なら補完取得）
    await this.fetchFollowingInitial();

    // チャンネルリスト取得
    this.fetchMyChannels();

    // UI更新
    this.updateLoginUI();

    console.log('✅ onAuthSuccessFromUI: 完了');
  }

  /**
   * kind:3 を購読し、フォローリストを DataStore に反映する。
   * EVENT または EOSE（タイムアウト含む）で resolve する。
   *
   * ログイン操作後専用。リロード時は fetchInitialData() が担う。
   *
   * @param {string} myPubkey
   * @returns {Promise<void>}
   * @private
   */
  _fetchAndApplyFollowList(myPubkey) {
    const TIMEOUT_MS = 8000;
    let resolved = false;

    return new Promise((resolve) => {
      const done = (hasFollowing) => {
        if (resolved) return;
        resolved = true;
        window.relayManager.unsubscribe('auth-following-check');
        console.log(`👥 kind:3 取得完了 (フォロー: ${hasFollowing ? 'あり' : 'なし'})`);
        resolve();
      };

      const timeoutId = setTimeout(() => {
        console.warn('⏱️ kind:3 タイムアウト → グローバルタイムラインで続行');
        done(false);
      }, TIMEOUT_MS);

      window.relayManager.subscribe('auth-following-check', {
        kinds: [3],
        authors: [myPubkey],
        limit: 1
      }, (type, event) => {
        if (type === 'EVENT') {
          clearTimeout(timeoutId);
          const pubkeys = event.tags
            .filter(t => t[0] === 'p')
            .map(t => t[1]);
          window.dataStore.setFollowingList(pubkeys);
          window.profileFetcher.requestMultiple(pubkeys);
          done(pubkeys.length > 0);
        } else if (type === 'EOSE') {
          clearTimeout(timeoutId);
          done(false);
        }
      });
    });
  }

  // ========================================
  // following タブ初期表示構築
  // ========================================

  /**
   * kind:3 確定後に呼ぶ following タブの初期表示構築。
   *
   * Step 1: DataStore の既存イベントをフォローフィルタで遡及登録（追加リクエスト不要）
   * Step 2: 遡及登録が THRESHOLD 件未満の場合のみ、following 専用 anchor-phase で補完取得
   *
   * @returns {Promise<void>}
   */
  async fetchFollowingInitial() {
    const followingSet = window.dataStore.followingPubkeys;
    if (followingSet.size === 0) {
      console.log('📭 フォロー0人のため following 初期取得をスキップ');
      return;
    }

    // ---- Step 1: 遡及登録 ----
    // DataStore に取得済みの全イベントのうち、フォロー中 pubkey のものを
    // following タブに登録する（追加ネットワークリクエスト不要）
    let retroCount = 0;
    for (const event of window.dataStore.getAllEvents()) {
      if ([1, 6, 42].includes(event.kind) && followingSet.has(event.pubkey)) {
        window.viewState.addHistoryEventToTab(event, 'following');
        retroCount++;
      }
    }
    console.log(`📋 following 遡及登録: ${retroCount}件`);

    // 十分な件数があれば補完リクエスト不要
    const THRESHOLD = 10;
    if (retroCount >= THRESHOLD) {
      window.viewState.renderNow();
      return;
    }

    // ---- Step 2: following 専用 anchor-phase で補完 ----
    console.log(`📡 following-anchor-phase 開始（遡及 ${retroCount}件 < ${THRESHOLD}件のため補完）`);
    const authors = Array.from(followingSet);

    return new Promise((resolve) => {
      const events = [];
      let resolved = false;
      const TIMEOUT_MS = 10000;

      const done = () => {
        if (resolved) return;
        resolved = true;
        window.relayManager.unsubscribe('following-anchor-phase');
        console.log(`✅ following-anchor-phase 完了: ${events.length}件取得`);
        window.viewState.renderNow();
        resolve();
      };

      const timeoutId = setTimeout(() => {
        console.warn('⏱️ following-anchor-phase タイムアウト');
        done();
      }, TIMEOUT_MS);

      window.relayManager.subscribe('following-anchor-phase', {
        kinds: [1],
        authors,
        limit: 50
      }, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            events.push(event);
            window.viewState.addHistoryEventToTab(event, 'following');
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          clearTimeout(timeoutId);
          done();
        }
      });
    });
  }

  // ========================================
  // DOMイベントリスナー登録
  // ========================================

  /**
   * null安全なイベントリスナー登録ヘルパー
   * @private
   */
  _addEvent(id, eventType, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(eventType, handler);
  }

  /**
   * すべてのDOMイベントリスナーを登録する
   * ※ init()の末尾から呼ばれる（DOM確定・非同期初期化完了後）
   */
  setupEventListeners() {

    // ----------------------------------------
    // 投稿
    // ----------------------------------------
    this._addEvent('send-new-post', 'click', () => {
      const content = document.getElementById('new-post-content')?.value;
      const kindEl = document.getElementById('post-kind-selector');
      const channelEl = document.getElementById('channel-list-selector');

      const kind = kindEl ? parseInt(kindEl.value) : 1;
      const channelId = channelEl ? channelEl.value : '';

      if (content) {
        if (kind === 42 && !channelId) {
          alert('送信先のチャンネルを選んでください！');
          return;
        }
        this.sendPost(content, kind, channelId);
      }
    });

    // Ctrl+Enter で送信
    this._addEvent('new-post-content', 'keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('send-new-post')?.click();
      }
    });

    // ----------------------------------------
    // Kind切り替え
    // ----------------------------------------
    this._addEvent('post-kind-selector', 'change', (e) => {
      const channelSelector = document.getElementById('channel-list-selector');
      if (!channelSelector) return;

      if (e.target.value === '42') {
        channelSelector.style.display = 'inline';
        this.fetchMyChannels();
      } else {
        channelSelector.style.display = 'none';
      }
    });

    // ----------------------------------------
    // チャンネル選択 → 投稿先設定 & タブ切替を同時に行う
    // ----------------------------------------
    this._addEvent('channel-list-selector', 'change', (e) => {
      const channelId = e.target.value;
      if (!channelId) return;
      // 選択されたチャンネルのタブを開く（投稿先も同じ値を参照するので追加処理不要）
      this.switchToChannelTab(channelId);
    });

    // ----------------------------------------
    // リレー接続
    // ----------------------------------------
    this._addEvent('subscribe-relay', 'click', async () => {
      const urlInput = document.getElementById('relay-url');
      const url = urlInput ? urlInput.value.trim() : '';

      if (url) {
        this.connectRelay(url);
      } else {
        // URLが空なら現在の接続でタイムラインをリフレッシュ
        console.log('🔄 タイムラインをリフレッシュします');

        const btn = document.getElementById('subscribe-relay');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '接続中...';
        }

        await this.initializeTimelineBaseline();

        if (btn) {
          btn.disabled = false;
          btn.textContent = '接続';
        }
      }
    });

    // ----------------------------------------
    // タブ切り替え
    // ----------------------------------------
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.id.replace('tab-', '');

        // チャンネルタブは専用処理
        if (tab === 'channel') {
          if (this.activeChannelId) {
            this.switchToChannelTab(this.activeChannelId);
          }
          return;
        }

        this.switchTab(tab);
      });
    });

    // ----------------------------------------
    // フィルター適用・クリア
    // ----------------------------------------
    this._addEvent('apply-filter', 'click', () => {
      const inputEl = document.getElementById('hex-filter');
      if (!inputEl) return;
      const input = inputEl.value;
      const authors = input.split(/[ ,\n]/)
        .map(s => s.trim())
        .filter(s => s.length === 64 || s.startsWith('npub'))
        .map(s => {
          if (s.startsWith('npub')) {
            try { return NostrTools.nip19.decode(s).data; } catch (e) { return null; }
          }
          return s;
        })
        .filter(Boolean);

      this.applyFilter(authors);
      localStorage.setItem('hexFilterValue', input);
    });

    this._addEvent('clear-filter', 'click', () => {
      const inputEl = document.getElementById('hex-filter');
      if (inputEl) inputEl.value = '';
      this.applyFilter(null);
      localStorage.removeItem('hexFilterValue');
    });

    // ----------------------------------------
    // flowgazer絞り込みトグル
    // ----------------------------------------
    this._addEvent('filter-flowgazer-only', 'change', (e) => {
      this.toggleFlowgazerFilter(e.target.checked);
    });

    // ----------------------------------------
    // kind:42表示切り替え
    // ----------------------------------------
    const kind42Checkbox = document.getElementById('toggle-kind42');
    if (kind42Checkbox) {
      // コンストラクタで復元済みの this.showKind42 をチェックボックスに反映する
      kind42Checkbox.checked = this.showKind42;

      kind42Checkbox.addEventListener('change', (e) => {
        this.toggleKind42Display(e.target.checked);
      });
    }

    // ----------------------------------------
    // 自動更新トグル
    // ----------------------------------------
    this._addEvent('auto-update-toggle', 'change', (e) => {
      this.isAutoUpdate = e.target.checked;
      if (e.target.checked) window.viewState.renderNow();
    });

    // ----------------------------------------
    // もっと見る
    // ----------------------------------------
    this._addEvent('load-more', 'click', function () {
      // NOTE: thisはボタン要素になるよう通常関数で定義
      this.classList.add('loading');
      window.app.loadMore();
    });

    // ----------------------------------------
    // 詳細設定トグル
    // ----------------------------------------
    this._addEvent('show-settings', 'click', () => {
      document.getElementById('advanced-settings')?.classList.remove('hidden');
      document.getElementById('show-settings')?.classList.add('hidden');
      document.getElementById('hide-settings')?.classList.remove('hidden');
    });

    this._addEvent('hide-settings', 'click', () => {
      document.getElementById('advanced-settings')?.classList.add('hidden');
      document.getElementById('hide-settings')?.classList.add('hidden');
      document.getElementById('show-settings')?.classList.remove('hidden');
    });

    // ----------------------------------------
    // ふぁぼマーク
    // ----------------------------------------
    const favInput = document.getElementById('kind-7-content-input');
    if (favInput) {
      favInput.addEventListener('change', (e) => this.saveFavMark(e.target.value));
      this.loadFavMark();
    }

    // ----------------------------------------
    // localStorage復元
    // ----------------------------------------
    const savedFilter = localStorage.getItem('hexFilterValue');
    if (savedFilter) {
      const hexFilterEl = document.getElementById('hex-filter');
      if (hexFilterEl) hexFilterEl.value = savedFilter;
    }

    // ----------------------------------------
    // visibilitychange（復帰時リフレッシュ）
    // ----------------------------------------
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        const idleTime = (now - this.lastActiveTime) / 1000;

        console.log(`復帰: 離脱時間 ${idleTime}秒`);

        if (idleTime > 30) {
          this.initializeTimelineBaseline();
        }
      } else {
        this.lastActiveTime = Date.now();
      }
    });

    console.log('✅ イベントリスナー登録完了');
  }

  // ========================================
  // ふぁぼマーク管理
  // ========================================

  /**
   * ふぁぼマークを保存
   * @param {string} val
   */
  saveFavMark(val) {
    const chars = Array.from(val);
    const singleChar = chars.length > 0 ? chars[0] : '+';
    localStorage.setItem('favMark', singleChar);
    const input = document.getElementById('kind-7-content-input');
    if (input) input.value = singleChar;
  }

  /**
   * 保存済みふぁぼマークをUIに反映
   */
  loadFavMark() {
    const savedMark = localStorage.getItem('favMark');
    const input = document.getElementById('kind-7-content-input');
    if (savedMark && input) input.value = savedMark;
  }

  // ========================================
  // Baseline方式タイムライン初期化
  // ========================================

  /**
   * Baseline方式でタイムラインを初期化（2段階処理）
   */
  async initializeTimelineBaseline() {
    if (this.isInitializing) {
      console.warn('⚠️ すでに初期化中です');
      return;
    }

    this.isInitializing = true;
    console.log('📡 Baseline方式: Anchor Phase開始');

    // ===== 第1段階: Anchor Phase (現在の cursorSince を渡す) =====
    const anchorResult = await this.executeAnchorPhase(this.cursorSince);

    if (!anchorResult.success) {
      this.isInitializing = false;
      // 初回起動（cursorSinceがない）かつ 0件のときだけアラートを出す
      if (anchorResult.isEmpty && !this.cursorSince) {
        alert('投稿が見つかりませんでした');
      }
      return;
    }

    // 新しく取れた中で一番古い時刻、または以前の時刻を維持
    this.cursorSince = anchorResult.oldestTimestamp || this.cursorSince;
    console.log(`✅ Anchor Phase完了: cursor_since=${new Date(this.cursorSince * 1000).toLocaleString()}`);

    // ===== 第2段階: Stream Phase =====
    // すでに動いている場合は一度止めてから再開
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();

    this.isInitializing = false;
  }

  /**
     * Anchor Phase: kind:1を取得
     * @param {number|null} since - 指定された場合、その時刻以降のみ取得
     * @returns {Object} { success, oldestTimestamp, isEmpty }
     */
  async executeAnchorPhase(since = null) {
    return new Promise((resolve) => {
      const events = [];
      let resolved = false;
      const TIMEOUT_MS = 10000; // 10秒

      const resolveOnce = (result) => {
        if (resolved) return;
        resolved = true;
        window.relayManager.unsubscribe('anchor-phase');
        resolve(result);
      };

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        console.log('⏱️ Anchor Phase: タイムアウト');
        if (events.length === 0) {
          // since指定がある（復帰時）なら、0件でも「異常なし」として成功を返す
          resolveOnce({ success: since ? true : false, isEmpty: since ? false : true, oldestTimestamp: since });
        } else {
          const oldest = Math.min(...events.map(e => e.created_at));
          resolveOnce({ success: true, oldestTimestamp: oldest });
        }
      }, TIMEOUT_MS);

      // --- フィルタの構築 ---
      const filter = {
        kinds: [1],
        limit: 150
      };

      // もし since があれば、その時刻 + 1秒 から取得を開始する
      if (since) {
        filter.since = since + 1;
        console.log(`📡 復帰リクエスト: ${new Date((since + 1) * 1000).toLocaleString()} 以降を取得`);
      }

      // 購読開始
      window.relayManager.subscribe('anchor-phase', filter, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            events.push(event);
            window.viewState.onEventReceived(event);
            window.profileFetcher.request(event.pubkey);

            // 150件到達で一旦区切る
            if (events.length >= 150) {
              clearTimeout(timeoutId);
              const oldest = Math.min(...events.map(e => e.created_at));
              resolveOnce({ success: true, oldestTimestamp: oldest });
            }
          }
        } else if (type === 'EOSE') {
          clearTimeout(timeoutId);
          console.log(`📡 Anchor Phase EOSE: ${events.length}件取得`);

          // since指定がある復帰時は、0件でも「最新の状態」なので成功扱いにする
          if (events.length === 0) {
            resolveOnce({
              success: since ? true : false,
              isEmpty: since ? false : true,
              oldestTimestamp: since || Math.floor(Date.now() / 1000)
            });
          } else {
            const oldest = Math.min(...events.map(e => e.created_at));
            resolveOnce({ success: true, oldestTimestamp: oldest });
          }
        }
      });
    });
  }

  /**
   * Stream Phase: since指定でリアルタイム購読
   */
  executeStreamPhase() {
    console.log('📡 Stream Phase開始');
    console.log('Current cursorSince:', this.cursorSince);

    const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;
    const filters = this.subscriptionBuilder.buildStreamPhaseFilters(myPubkey);

    window.relayManager.subscribe('stream-phase', filters, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          this._notifyLikedByMe(event, myPubkey);
          window.viewState.onEventReceived(event);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('📡 Stream Phase EOSE受信');
        window.profileFetcher.flushNow();
      }
    }, { persistent: true });
  }

  // ========================================
  // リレー接続管理
  // ========================================

  /**
   * リレーに接続
   * @param {string} url
   */
  async connectRelay(url) {
    try {
      document.getElementById('relay-url').value = url;
      await window.relayManager.connect(url);
      localStorage.setItem('relayUrl', url);
    } catch (err) {
      console.error('❌ リレー接続失敗:', err);
      alert('リレーに接続できませんでした: ' + url);
    }
  }

  // ========================================
  // 初期データ取得
  // ========================================

  /**
   * ログイン後の初期データ取得
   * フォローリストが確定したタイミングで Stream Phase を再起動し、
   * following タブをリロード不要で反映させる。
   */
  fetchInitialData() {
    const myPubkey = window.nostrAuth.pubkey;
    if (!myPubkey) {
      console.warn('⚠️ fetchInitialData: pubkey 未確定のためスキップ');
      return;
    }

    // 1. フォローリスト取得
    window.relayManager.subscribe('following-list', {
      kinds: [3],
      authors: [myPubkey],
      limit: 1
    }, (type, event) => {
      if (type === 'EVENT') {
        const pubkeys = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
        window.dataStore.setFollowingList(pubkeys);
        window.profileFetcher.requestMultiple(pubkeys);

        // フォローリスト確定 → Stream Phase を following フィルタ込みで再起動
        console.log(`👥 フォローリスト確定 (${pubkeys.length}人) → Stream Phase 再起動`);
        window.relayManager.unsubscribe('stream-phase');
        this.executeStreamPhase();

        // following タブ初期表示を構築（遡及登録 → 必要なら補完取得）
        this.fetchFollowingInitial();
      }
    }, { persistent: true });

    // 2. 自分のふぁぼ取得
    window.relayManager.subscribe('my-likes', {
      kinds: [7],
      authors: [myPubkey]
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          this._notifyLikedByMe(event, myPubkey);
          window.viewState.onEventReceived(event);
        }
      }
    }, { persistent: true });
  }

  /**
   * 自分の投稿履歴を取得 (mypostsタブ用)
   */
  fetchMyPostsHistory() {
    const myPubkey = window.nostrAuth.pubkey;
    console.log('📥 自分の投稿履歴を取得中...');

    window.relayManager.subscribe('my-posts-history', {
      kinds: [1, 42],
      authors: [myPubkey],
      limit: 100
    }, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'myposts');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ 自分の投稿履歴取得完了');
        window.viewState.renderNow();
      }
    });
  }

  /**
   * 受け取ったリアクション等を取得
   */
  fetchReceivedLikes() {
    const myPubkey = window.nostrAuth.pubkey;
    if (!myPubkey) return;

    console.log('📥 通知（likesタブ用）を独立取得中...');

    const filter = {
      kinds: [1, 6, 7],
      '#p': [myPubkey],
      limit: 50
    };

    window.relayManager.subscribe('received-notifications-init', filter, (type, event) => {
      if (type === 'EVENT') {
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, 'likes');
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ 通知初期取得完了');
        window.viewState.renderNow();
      }
    });
  }

  // ========================================
  // タブ切り替え
  // ========================================

  /**
   * タブ切り替え
   * @param {string} tab
   */
  switchTab(tab) {
    this.currentTab = tab;
    console.log('🔀 タブ切り替え:', tab);

    document.querySelectorAll('.tab-button').forEach(btn => {
      if (window.viewState.isChannelTab(tab)) {
        btn.classList.toggle('active', btn.id === 'tab-channel');
      } else {
        btn.classList.toggle('active', btn.id === `tab-${tab}`);
      }
    });

    // チャンネルタブはswitchToChannelTabで処理済みなのでスキップ
    if (!window.viewState.isChannelTab(tab)) {
      window.viewState.switchTab(tab);
    }

    this._ensureTabDataFetched(tab);

    if (window.timeline) {
      window.timeline.switchTab(tab);
    }
  }

  /**
   * タブの初回データ取得を保証する。
   * ログイン済みかつ未取得のタブに対してのみデータ取得を実行する。
   * @param {string} tab
   * @private
   */
  _ensureTabDataFetched(tab) {
    if (this.tabDataFetched[tab] || !window.nostrAuth.isLoggedIn()) return;

    const fetchers = {
      myposts: () => this.fetchMyPostsHistory(),
      likes:   () => this.fetchReceivedLikes(),
    };

    if (fetchers[tab]) {
      fetchers[tab]();
      this.tabDataFetched[tab] = true;
    }
  }

  /**
   * kind:7 イベントが自分のふぁぼであれば DataStore に通知する。
   *
   * DataStore は認証状態を知らないため、「自分の投稿か」の判定を
   * app.js がここで一元的に行い、markAsLikedByMe() で結果だけを渡す。
   *
   * @param {Object} event - 追加済みの Nostr イベント
   * @param {string|null} myPubkey
   * @private
   */
  _notifyLikedByMe(event, myPubkey) {
    if (!myPubkey) return;
    if (event.kind !== 7) return;
    if (event.pubkey !== myPubkey) return;

    const targetEventId = event.tags.find(t => t[0] === 'e')?.[1];
    if (targetEventId) {
      window.dataStore.markAsLikedByMe(targetEventId);
    }
  }

  // ========================================
  // フィルタ管理
  // ========================================

  /**
   * 投稿者フィルタを適用
   * @param {string[]|null} authors
   */
  applyFilter(authors) {
    this.filterAuthors = authors;

    if (window.timeline) {
      window.timeline.setFilter({ authors });
    }

    // Stream Phaseを再開
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();
  }

  /**
   * flowgazerしぼりこみトグル
   * @param {boolean} enabled
   */
  toggleFlowgazerFilter(enabled) {
    this.flowgazerOnly = enabled;

    if (window.timeline) {
      window.timeline.setFilter({ flowgazerOnly: enabled });
    }
  }

  /**
   * kind:42表示切り替え
   * @param {boolean} enabled
   */
  toggleKind42Display(enabled) {
    this.showKind42 = enabled;
    localStorage.setItem('showKind42', enabled.toString());
    console.log(`📺 kind:42表示: ${enabled ? 'ON' : 'OFF'}`);

    if (window.timeline) {
      window.timeline.setFilter({ showKind42: enabled });
    }

    // Stream Phaseを再開
    window.relayManager.unsubscribe('stream-phase');
    this.executeStreamPhase();
  }

  // ========================================
  // もっと見る (LoadMore - 連鎖リクエスト方式)
  // ========================================

  /**
   * もっと見るボタンの処理（連鎖リクエスト方式）
   */
  async loadMore() {
    if (this.isLoadingMore) {
      console.warn('ロード中のため、重複処理をスキップ');
      return;
    }
    this.isLoadingMore = true;

    const tab = this.currentTab;
    const oldestTimestamp = window.viewState.getOldestTimestamp(tab);

    console.log(`📥 もっと見る: ${tab}タブ, until=${new Date(oldestTimestamp * 1000).toLocaleString()}`);

    document.getElementById('load-more').classList.add('loading');

    try {
      // Step 1: kind:1を50件取得
      const step1Result = await this.loadMoreStep1(tab, oldestTimestamp);

      if (!step1Result.success) {
        alert('これ以上ありません');
        return;
      }

      const oldestKind1 = step1Result.oldestTimestamp;
      console.log(`✅ Step1完了: ${step1Result.count}件取得, oldest=${new Date(oldestKind1 * 1000).toLocaleString()}`);

      // Step 2: その期間のkind:6,42を全件取得
      await this.loadMoreStep2(tab, oldestTimestamp, oldestKind1);

      if (tab === 'likes' && step1Result.success) {
        const tabState = window.viewState.tabs.likes;
        const oldestInBatch = step1Result.oldestTimestamp;

        // 取得した最古データに合わせて、表示下限（baseline）を過去へ広げる
        if (tabState.baseline === null || oldestInBatch < tabState.baseline) {
          tabState.baseline = oldestInBatch;
          console.log(`📉 likesタブのBaselineを拡張（LoadMore）: ${new Date(oldestInBatch * 1000).toLocaleString()}`);
        }
      }

      // カーソル更新
      window.viewState.updateTabCursor(tab, oldestKind1);

      console.log('✅ もっと見る完了');
      window.viewState.renderNow();

    } catch (err) {
      console.error('❌ もっと見る失敗:', err);
      alert('データの取得に失敗しました');
    } finally {
      document.getElementById('load-more').classList.remove('loading');
      this.isLoadingMore = false;
    }
  }

  /**
   * LoadMore Step1: kind:1を50件取得
   * @private
   */
  async loadMoreStep1(tab, untilTimestamp) {
    return new Promise((resolve) => {
      const events = [];
      const myPubkey = window.nostrAuth?.pubkey;

      const filter = this.subscriptionBuilder.buildLoadMoreStep1Filter(tab, untilTimestamp, myPubkey);
      if (!filter) {
        resolve({ success: false });
        return;
      }

      window.relayManager.subscribe('load-more-step1', filter, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            events.push(event);
            window.viewState.addHistoryEventToTab(event, tab);
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          window.relayManager.unsubscribe('load-more-step1');

          if (events.length === 0) {
            resolve({ success: false });
          } else {
            const oldest = Math.min(...events.map(e => e.created_at));
            resolve({ success: true, count: events.length, oldestTimestamp: oldest });
          }
        }
      });
    });
  }

  /**
   * LoadMore Step2: kind:6,42を期間指定で全件取得
   * @private
   */
  async loadMoreStep2(tab, untilTimestamp, sinceTimestamp) {
    return new Promise((resolve) => {
      const myPubkey = window.nostrAuth?.pubkey;
      const filter = this.subscriptionBuilder.buildLoadMoreStep2Filter(tab, untilTimestamp, sinceTimestamp, myPubkey);
      if (!filter) {
        resolve();
        return;
      }

      window.relayManager.subscribe('load-more-step2', filter, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            window.viewState.addHistoryEventToTab(event, tab);
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          window.relayManager.unsubscribe('load-more-step2');
          console.log('✅ Step2完了');
          resolve();
        }
      });
    });
  }

  // ========================================
  // ユーザーアクション
  // ========================================

  /**
   * 投稿を送信
   * @param {string} content
   */
  async sendPost(content, kind = 1, channelId = null, tempNsec = null) {
    // 1. セッション用nsecが入力された場合は、まずそれをセット
    if (tempNsec) {
      try {
        window.nostrAuth.setSessionNsec(tempNsec);
      } catch (e) {
        alert(e.message);
        return;
      }
    }

    // 2. 書き込み権限チェック（セッション鍵があればここを通る）
    if (!window.nostrAuth.canWrite()) {
      alert('投稿するには秘密鍵でのサインインが必要です。');
      showAuthUI();
      return;
    }

    try {
      const event = {
        kind: kind,
        content: content,
        created_at: Math.floor(Date.now() / 1000),
        tags: []
      };

      if (kind === 42) {
        if (!channelId) {
          alert('投稿先のチャンネルを選んでください！');
          return;
        }
        event.tags.push(['e', channelId, '', 'root']);
      }

      event.tags.push(['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/']);

      // 3. 署名
      const signed = await window.nostrAuth.signEvent(event, tempNsec);

      window.relayManager.publish(signed);
      window.dataStore.addEvent(signed);
      window.viewState.onEventReceived(signed);
      window.timeline.refresh();

      alert('送信完了！');
      document.getElementById('new-post-content').value = '';

      // 4. 送信成功後のUI更新
      this.updateLoginUI();

    } catch (err) {
      console.error('投稿失敗:', err);
      alert('投稿に失敗しました: ' + err.message);
    }
  }

  /**
   * ふぁぼを送信
   */
  async sendLike(targetEventId, targetPubkey) {
    if (!window.nostrAuth.canWrite()) {
      alert('ふぁぼるには秘密鍵でのサインインが必要です。');
      return;
    }

    try {
      const kind7Content = document.getElementById('kind-7-content-input').value.trim() || '+';

      const event = {
        kind: 7,
        content: kind7Content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', targetEventId],
          ['p', targetPubkey]
        ]
      };

      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);
      window.dataStore.addEvent(signed);
      this._notifyLikedByMe(signed, window.nostrAuth.pubkey);
      window.viewState.onEventReceived(signed);
      window.viewState.renderNow();

      alert('ふぁぼった!');

    } catch (err) {
      console.error('失敗:', err);
      alert('ふぁぼれませんでした: ' + err.message);
    }
  }

  // ========================================
  // 禁止ワード管理
  // ========================================

  /**
   * 禁止ワードリストを取得
   */
  async fetchForbiddenWords() {
    try {
      const response = await fetch('https://ompomz.github.io/flowgazer/nglist.xml');
      const xmlText = await response.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const terms = xmlDoc.querySelectorAll('term');

      this.forbiddenWords = Array.from(terms).map(node => node.textContent);
      console.log('📋 禁止ワードリスト読み込み完了:', this.forbiddenWords.length, '件');

    } catch (err) {
      console.error('禁止ワードリスト読み込み失敗:', err);
      this.forbiddenWords = [];
    }
  }

  // ========================================
  // UI更新
  // ========================================

  /**
   * ログインUI更新
   */
  updateLoginUI() {
    const notLoggedInSpan = document.getElementById('not-logged-in');
    const npubLink = document.getElementById('npub-link');
    const tempInput = document.getElementById('temp-nsec-input');
    const auth = window.nostrAuth;

    // 1. 基本的なログイン状態の表示
    if (auth.isLoggedIn()) {
      const npub = window.NostrTools.nip19.npubEncode(auth.pubkey);
      npubLink.textContent = npub.substring(0, 20) + '...';
      npubLink.href = 'https://nostter.app/' + npub;
      npubLink.style.display = 'inline';
      notLoggedInSpan.style.display = 'none';
    } else {
      npubLink.style.display = 'none';
      notLoggedInSpan.style.display = 'inline';
    }

    // 2. ROMモード時の「書き込み用鍵」の状態表示
    if (tempInput) {
      if (auth.readOnly) {
        if (auth.sessionPubkey) {
          const sNpub = window.NostrTools.nip19.npubEncode(auth.sessionPubkey);
          const shortSNpub = sNpub.substring(0, 8) + '...';

          tempInput.style.display = 'none';

          let statusBadge = document.getElementById('session-write-status');
          if (!statusBadge) {
            statusBadge = document.createElement('a');
            statusBadge.id = 'session-write-status';
            statusBadge.target = '_blank';
            tempInput.parentNode.insertBefore(statusBadge, tempInput);
          }
          statusBadge.textContent = `${shortSNpub}`;
          statusBadge.href = `https://nostter.app/${sNpub}`;
          statusBadge.title = `${sNpub}`;
          statusBadge.style.display = 'inline';
        } else {
          tempInput.style.display = 'inline-block';
          const statusBadge = document.getElementById('session-write-status');
          if (statusBadge) statusBadge.style.display = 'none';
        }
      } else {
        tempInput.style.display = 'none';
        const statusBadge = document.getElementById('session-write-status');
        if (statusBadge) statusBadge.style.display = 'none';
      }
    }
    this.updateTabVisibility();
  }

  updateTabVisibility() {
    const auth = window.nostrAuth;
    // ログインしているかどうかの判定結果をログに出す
    const isLoggedIn = auth && typeof auth.isLoggedIn === 'function' && auth.isLoggedIn();

    console.log("Checking Tabs - IsLoggedIn:", isLoggedIn);
    console.log("Current Pubkey:", auth?.pubkey);

    const tabButtons = document.getElementById('tab-buttons');
    if (!tabButtons) {
      console.error("Error: tab-buttons element not found!");
      return;
    }

    // 判定
    if (isLoggedIn) {
      tabButtons.style.display = 'flex';
      console.log("Tabs should be VISIBLE now.");
    } else {
      tabButtons.style.display = 'none';
      console.log("Tabs are HIDDEN because isLoggedIn is false.");
    }

    // 各タブボタンの個別制御
    const tabsToToggle = ['tab-following', 'tab-myposts', 'tab-likes'];
    tabsToToggle.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = isLoggedIn ? '' : 'none';
    });
  }

  /**
   * チャンネルタブへ切り替え（初回は取得、2回目以降はキャッシュ利用）
   * @param {string} channelId
   */
  async switchToChannelTab(channelId) {
    const tabKey = `channel:${channelId}`;
    this.activeChannelId = channelId;
    this.currentTab = tabKey;

    // チャンネルタブボタンのラベルを更新
    const channelName = window.channelNameMap?.get(channelId) || channelId.substring(0, 8) + '...';
    this._updateChannelTabButton(channelName);

    // タブボタンのアクティブ状態を切り替え
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.id === 'tab-channel');
    });

    // ViewState にタブを生成させてから切り替え
    window.viewState.getOrCreateChannelTab(channelId);
    window.viewState.switchTab(tabKey);
    window.timeline?.switchTab(this.currentTab);

    // 初回のみリレーから取得
    if (!this.tabDataFetched[tabKey]) {
      this.tabDataFetched[tabKey] = true;
      await this.fetchChannelHistory(channelId);
    }

    // Stream Phase にチャンネルフィルタを追加（再購読）
    window.relayManager.unsubscribe('stream-channel');
    this.executeChannelStreamPhase(channelId);
  }

  /**
   * チャンネルの過去投稿を取得
   * @param {string} channelId
   */
  async fetchChannelHistory(channelId) {
    const tabKey = `channel:${channelId}`;
    console.log(`📥 チャンネル履歴取得: ${channelId}`);

    return new Promise((resolve) => {
      window.relayManager.subscribe(`channel-history-${channelId}`, {
        kinds: [42],
        '#e': [channelId],
        limit: 100
      }, (type, event) => {
        if (type === 'EVENT') {
          const added = window.dataStore.addEvent(event);
          if (added) {
            window.viewState.addHistoryEventToTab(event, tabKey);
            window.profileFetcher.request(event.pubkey);
          }
        } else if (type === 'EOSE') {
          window.relayManager.unsubscribe(`channel-history-${channelId}`);
          console.log(`✅ チャンネル履歴取得完了: ${channelId}`);
          window.viewState.renderNow();
          resolve();
        }
      });
    });
  }

  /**
   * チャンネル専用リアルタイム購読
   * @param {string} channelId
   */
  executeChannelStreamPhase(channelId) {
    const since = window.viewState.tabs[`channel:${channelId}`]?.cursor?.since
      || Math.floor(Date.now() / 1000);

    window.relayManager.subscribe('stream-channel', {
      kinds: [42],
      '#e': [channelId],
      since
    }, (type, event) => {
      if (type === 'EVENT') {
        const tabKey = `channel:${channelId}`;
        const added = window.dataStore.addEvent(event);
        if (added) {
          window.viewState.addHistoryEventToTab(event, tabKey);
          window.profileFetcher.request(event.pubkey);
        }
      }
    }, { persistent: true });
  }

  /**
   * チャンネルタブボタンのラベルを更新
   * @param {string} name
   */
  _updateChannelTabButton(name) {
    const btn = document.getElementById('tab-channel');
    if (btn) {
      // 長い名前は切り詰める
      btn.textContent = name.length > 12 ? name.substring(0, 12) + '…' : name;

      // style.displayをいじるのではなく、クラスで制御する
      btn.classList.remove('hidden');
    }
  }

  // ========================================
  // チャンネル管理
  // ========================================

  /**
   * 自分のチャンネルリストを取得し、各チャンネルの名前を解決する
   */
  async fetchMyChannels() {
    const myPubkey = window.nostrAuth?.pubkey;
    if (!myPubkey) return;

    console.log('📡 チャンネルリスト取得開始...');

    const subId = 'my-channels-' + Date.now();

    window.relayManager.subscribe(subId, {
      kinds: [10005],
      authors: [myPubkey],
      limit: 1
    }, async (type, event) => {
      if (type === 'EVENT' && event.kind === 10005) {
        console.log('✅ kind:10005 受信:', event.tags);

        const channelIds = event.tags
          .filter(t => t[0] === 'e' && t[1])
          .map(t => t[1]);

        if (channelIds.length === 0) {
          console.warn('⚠️ チャンネルが見つかりませんでした');
          this._updateChannelDropdown([]);
          window.relayManager.unsubscribe(subId);
          return;
        }

        console.log(`📋 ${channelIds.length}個のチャンネルIDを取得`);

        await this._resolveChannelNames(channelIds);

        window.relayManager.unsubscribe(subId);
      }

      if (type === 'EOSE') {
        window.relayManager.unsubscribe(subId);
      }
    });
  }

  /**
   * チャンネルID配列から名前を解決してプルダウンを更新
   * @private
   */
  async _resolveChannelNames(channelIds) {
    return new Promise((resolve) => {
      const channels = [];
      const resolved = new Set();
      const subId41 = 'channel-meta-41-' + Date.now();

      console.log('🔍 チャンネル名解決開始（kind:41 優先）');

      window.relayManager.subscribe(
        subId41,
        { kinds: [41], '#e': channelIds },
        (type, event) => {
          if (type === 'EVENT') {
            const channelId = event.tags.find(t => t[0] === 'e')?.[1];
            if (!channelId || !channelIds.includes(channelId)) return;

            try {
              const metadata = JSON.parse(event.content);
              const name = metadata.name || `Channel ${channelId.substring(0, 8)}`;
              window.channelNameMap.set(channelId, name);

              const existing = channels.find(c => c.id === channelId);
              if (!existing || event.created_at > existing.created_at) {
                if (existing) {
                  existing.name = name;
                  existing.created_at = event.created_at;
                  existing.source = '41';
                } else {
                  channels.push({ id: channelId, name, created_at: event.created_at, source: '41' });
                }
                resolved.add(channelId);
                console.log(`✅ kind:41 から解決: ${name}`);
              }
            } catch (err) {
              console.error('❌ kind:41 パース失敗:', err);
            }
          }

          if (type === 'EOSE') {
            window.relayManager.unsubscribe(subId41);
            fetchKind40Fallback();
          }
        }
      );

      const fetchKind40Fallback = () => {
        const unresolvedIds = channelIds.filter(id => !resolved.has(id));

        if (unresolvedIds.length === 0) {
          finish();
          return;
        }

        console.log(`🔁 kind:40 で補完 (${unresolvedIds.length} 件)`);

        const subId40 = 'channel-meta-40-' + Date.now();

        window.relayManager.subscribe(
          subId40,
          { kinds: [40], ids: unresolvedIds },
          (type, event) => {
            if (type === 'EVENT' && unresolvedIds.includes(event.id)) {
              try {
                const metadata = JSON.parse(event.content);
                const name = metadata.name || `Channel ${event.id.substring(0, 8)}`;
                window.channelNameMap.set(event.id, name);

                channels.push({ id: event.id, name, created_at: event.created_at, source: '40' });
                resolved.add(event.id);
                console.log(`✅ kind:40 から解決: ${name}`);
              } catch (err) {
                console.error('❌ kind:40 パース失敗:', err);
              }
            }

            if (type === 'EOSE') {
              window.relayManager.unsubscribe(subId40);
              finish();
            }
          }
        );
      };

      const finish = () => {
        channelIds.forEach(id => {
          if (!resolved.has(id)) {
            channels.push({ id, name: `Channel ${id.substring(0, 8)}...`, created_at: 0, source: 'default' });
          }
        });

        localStorage.setItem('myChannels', JSON.stringify(channels));
        this._updateChannelDropdown(channels);
        resolve();
      };

      setTimeout(() => {
        console.log('⏱️ チャンネル名解決タイムアウト');
        finish();
      }, 5000);
    });
  }

  /**
   * チャンネル情報をプルダウンに反映する
   * @private
   */
  _updateChannelDropdown(channels) {
    const channelSelect = document.getElementById('channel-list-selector');
    if (!channelSelect) return;

    const currentValue = channelSelect.value;
    channelSelect.innerHTML = '<option value="">-- チャンネルを選択 --</option>';

    if (channels.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'チャンネルが見つかりませんでした';
      option.disabled = true;
      channelSelect.appendChild(option);
      console.log('⚠️ 表示可能なチャンネルがありません');
      return;
    }

    channels.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    channels.forEach(channel => {
      const option = document.createElement('option');
      option.value = channel.id;
      option.textContent = channel.name;
      if (channel.id === currentValue) option.selected = true;
      channelSelect.appendChild(option);
    });

    console.log(`✅ プルダウンに ${channels.length} 件のチャンネルをセットしました`);
  }
}

// ========================================
// グローバル初期化
// ========================================

window.channelNameMap = new Map();

window.app = new FlowgazerApp();
console.log('✅ FlowgazerApp初期化完了');

window.sendLikeEvent = (eventId, pubkey) => window.app.sendLike(eventId, pubkey);

window.addEventListener('beforeunload', () => {
  if (window.timeline) {
    window.timeline.destroy();
  }
  if (window.relayManager) {
    window.relayManager.disconnect();
  }
  console.log('🗑️ アプリケーションクリーンアップ完了');
});