/**
 * app.js
 * アプリケーション全体の制御
 */

class FlowgazerApp {
  constructor() {
    this.currentTab = 'global';
    this.isAutoUpdate = true;
    this.filterAuthors = null;
    this.flowgazerOnly = false;
    this.forbiddenWords = [];

  }

  /**
   * 初期化
   */
  async init() {
    console.log('🚀 flowgazer起動中...');

    // 鍵入力状況を反映
    this.updateLoginUI();

    // デフォルトリレーに接続
    const savedRelay = localStorage.getItem('relayUrl');
    const defaultRelay = 'wss://r.kojira.io/';
    const relay = savedRelay || defaultRelay;

    await this.connectRelay(relay);

    // 禁止ワードリストを取得
    await this.fetchForbiddenWords();

    // 鍵入力済みなら初期データ取得
    if (window.nostrAuth.isLoggedIn()) {
      this.fetchInitialData();
    }

    console.log('✅ flowgazer起動完了');
  }



  /**
   * リレーに接続
   */
  async connectRelay(url) {
    try {
      document.getElementById('relay-url').value = url;
      await window.relayManager.connect(url);

      // メインタイムラインを購読
      this.subscribeMainTimeline();

      // リレーURLを保存
      localStorage.setItem('relayUrl', url);

    } catch (err) {
      console.error('❌ リレー接続失敗:', err);
      alert('リレーに接続できませんでした: ' + url);
    }
  }

  /**
   * メインタイムラインを購読
   */
  subscribeMainTimeline() {
    const filters = [];
    const myPubkey = window.nostrAuth?.pubkey;

    // グローバルタイムライン
    if (this.currentTab === 'global') {
      const filter = { kinds: [1, 6], limit: 50 };
      if (this.filterAuthors && this.filterAuthors.length > 0) {
        filter.authors = this.filterAuthors;
      }
      filters.push(filter);
    }

    // フォロータイムライン
    if (this.currentTab === 'following' && window.dataStore.followingPubkeys.size > 0) {
      filters.push({
        kinds: [1, 6],
        authors: Array.from(window.dataStore.followingPubkeys),
        limit: 100
      });
    }

    // マイポストタイムライン
    if (this.currentTab === 'myposts' && myPubkey) {
      // リアクション取得のみ（投稿は履歴で取得済み）
      if (window.dataStore.myPostIds.size > 0) {
        filters.push({
          kinds: [6, 7],
          '#e': Array.from(window.dataStore.myPostIds)
        });
      }
    }

    // 購読
    if (filters.length > 0) {
      window.relayManager.subscribe('main-timeline', filters, (type, event) => {
        this.handleTimelineEvent(type, event);
      });
    }
  }

  /**
   * タイムラインイベントハンドラー
   */
  handleTimelineEvent(type, event) {
    if (type === 'EVENT') {
      // kind:0（プロファイル）
      if (event.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          const updated = window.dataStore.addProfile(event.pubkey, {
            ...profile,
            created_at: event.created_at
          });
          
          // プロファイル取得完了を通知
          if (updated) {
            window.viewState.onProfileFetched(event.pubkey);
          }
        } catch (err) {
          console.error('プロファイルパースエラー:', err);
        }
        return;
      }

      // kind:1, 6, 7を追加
      if (window.dataStore.addEvent(event)) {
        // ViewStateに追加（タブ判定を含む）
        window.viewState.addEvent(event, this.currentTab);
        
        // プロファイル取得をリクエスト
        window.profileFetcher.request(event.pubkey);
      }

    } else if (type === 'EOSE') {
      console.log('📡 EOSE受信');
      
      // プロファイルを即座にフラッシュ
      window.profileFetcher.flushNow();
    }
  }

  /**
   * 初期データ取得（鍵入力済みユーザー向け）
   */
  fetchInitialData() {
    const myPubkey = window.nostrAuth.pubkey;

    // 1. フォローリスト（kind:3）
    window.relayManager.subscribe('following-list', {
      kinds: [3],
      authors: [myPubkey],
      limit: 1
    }, (type, event) => {
      if (type === 'EVENT') {
        const pubkeys = event.tags
          .filter(t => t[0] === 'p')
          .map(t => t[1]);
        window.dataStore.setFollowingList(pubkeys);
        
        // フォロー中のプロファイルを取得
        window.profileFetcher.requestMultiple(pubkeys);
      }
    });

    // 2. 自分がふぁぼした履歴
    window.relayManager.subscribe('my-likes', {
      kinds: [7],
      authors: [myPubkey]
    }, (type, event) => {
      if (type === 'EVENT') {
        window.dataStore.addEvent(event);
        window.viewState.addEvent(event, this.currentTab);
      }
    });
  }

  /**
   * 自分の投稿履歴を取得（「自分」タブ用）
   */
  fetchMyPostsHistory() {    
    const myPubkey = window.nostrAuth.pubkey;    
    console.log('📥 自分の投稿履歴を取得中...');
    
    // 自分の投稿履歴
    window.relayManager.subscribe('my-posts-history', {
      kinds: [1],
      authors: [myPubkey],
      limit: 100
    }, (type, event) => {
      if (type === 'EVENT') {
        if (window.dataStore.addEvent(event)) {
          window.viewState.addEvent(event, this.currentTab);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ 自分の投稿履歴取得完了');
        window.viewState.renderNow();
      }
    });
  }

  /**
   * 受け取ったふぁぼを取得（「ふぁぼられ」タブ用）
   */
  fetchReceivedLikes() {    
    const myPubkey = window.nostrAuth.pubkey;
    
    console.log('📥 受け取ったふぁぼを取得中...');
    
    window.relayManager.subscribe('received-likes', {
      kinds: [7],
      '#p': [myPubkey],
      limit: 50
    }, (type, event) => {
      if (type === 'EVENT') {
        if (window.dataStore.addEvent(event)) {
          window.viewState.addEvent(event, this.currentTab);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        console.log('✅ 受け取ったふぁぼ取得完了');
        window.viewState.renderNow();
      }
    });
  }

  /**
   * タブを切り替え
   */
  switchTab(tab) {
    this.currentTab = tab;
    console.log('📑 タブ切り替え:', tab);

    // タブボタンのアクティブ状態を更新
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.id === `tab-${tab}`);
    });

    // タブ専用データの取得
    if (tab === 'myposts' && window.nostrAuth.isLoggedIn()) {
      this.fetchMyPostsHistory();
    } else if (tab === 'likes' && window.nostrAuth.isLoggedIn()) {
      this.fetchReceivedLikes();
    }

    // 購読を更新
    window.relayManager.unsubscribe('main-timeline');
    this.subscribeMainTimeline();

    // ViewStateに通知
    window.viewState.switchTab(tab);

    // タイムライン更新
    window.timeline.switchTab(tab);
  }

  /**
   * フィルターを適用
   */
  applyFilter(authors) {
    this.filterAuthors = authors;
    window.timeline.setFilter({ authors });

    // 購読を更新
    window.relayManager.unsubscribe('main-timeline');
    this.subscribeMainTimeline();
  }

  /**
   * flowgazerしぼりこみ
   */
  toggleFlowgazerFilter(enabled) {
    this.flowgazerOnly = enabled;
    window.timeline.setFilter({ flowgazerOnly: enabled });
  }

  /**
   * もっと見る
   */
  loadMore() {
    const oldestTimestamp = window.dataStore.getOldestTimestamp(this.currentTab);
    
    const filter = {
      kinds: [1, 6],
      until: oldestTimestamp - 1,
      limit: 50
    };

    // フィルターや著者の設定
    if (this.filterAuthors && this.filterAuthors.length > 0) {
      filter.authors = this.filterAuthors;
    } else if (this.currentTab === 'following' && window.dataStore.followingPubkeys.size > 0) {
      filter.authors = Array.from(window.dataStore.followingPubkeys);
    } else if (this.currentTab === 'myposts' && window.nostrAuth.isLoggedIn()) {
      filter.authors = [window.nostrAuth.pubkey];
    }

    console.log(`📥 もっと見る: ${this.currentTab}タブ, until=${new Date(oldestTimestamp * 1000).toLocaleString()}`);

    window.relayManager.subscribe('load-more', filter, (type, event) => {
      if (type === 'EVENT') {
        if (window.dataStore.addEvent(event)) {
          window.viewState.addEvent(event, this.currentTab);
          window.profileFetcher.request(event.pubkey);
        }
      } else if (type === 'EOSE') {
        window.relayManager.unsubscribe('load-more');
        document.getElementById('load-more').classList.remove('loading');
        console.log(`✅ もっと見る完了`);
        window.viewState.renderNow();
      }
    });
  }

  /**
   * 投稿
   */
  async sendPost(content) {
    if (!window.nostrAuth.canWrite()) {
      alert('投稿するには秘密鍵でのサインインが必要です。');
      showAuthUI();
      return;
    }

    try {
      const event = {
        kind: 1,
        content: content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['client', 'flowgazer', '31990:a19caaa8404721584746fb0e174cf971a94e0f51baaf4c4e8c6e54fa88985eaf:1755917022711', 'wss://relay.nostr.band/']
        ]
      };

      const signed = await window.nostrAuth.signEvent(event);
      window.relayManager.publish(signed);

      // 即座にDataStoreとViewStateに追加
      window.dataStore.addEvent(signed);
      window.viewState.addEvent(signed, this.currentTab);
      window.viewState.renderNow();

      alert('投稿しました！');
      document.getElementById('new-post-content').value = '';

    } catch (err) {
      console.error('投稿失敗:', err);
      alert('投稿に失敗しました: ' + err.message);
    }
  }

  /**
   * ふぁぼる
   */
  async sendLike(targetEventId, targetPubkey) {
    if (!window.nostrAuth.canWrite()) {
      alert('ふぁぼるには秘密鍵でのサインインが必要です。');
      showAuthUI();
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

      // 即座に反映
      window.dataStore.addEvent(signed);
      window.viewState.addEvent(signed, this.currentTab);
      window.viewState.renderNow();

      alert('ふぁぼった！');

    } catch (err) {
      console.error('失敗:', err);
      alert('ふぁぼれませんでした: ' + err.message);
    }
  }

  /**
   * 禁止ワードリスト取得
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
        this.forbiddenWords = []; // エラー時は空配列
      }
    }  

  /**
   * 鍵入力UI更新
   */
  updateLoginUI() {
    const notLoggedInSpan = document.getElementById('not-logged-in');
    const npubLink = document.getElementById('npub-link');

    if (window.nostrAuth.isLoggedIn()) {
      const npub = window.NostrTools.nip19.npubEncode(window.nostrAuth.pubkey);
      npubLink.textContent = npub.substring(0, 12) + '...' + npub.slice(-4);
      npubLink.href = 'https://nostter.app/' + npub;
      npubLink.style.display = 'inline';
      notLoggedInSpan.style.display = 'none';
    } else {
      npubLink.style.display = 'none';
      notLoggedInSpan.style.display = 'inline';
    }
  }
}

// グローバルインスタンス
window.app = new FlowgazerApp();
console.log('✅ flowgazerApp初期化完了');

// グローバル関数（UI用）
window.sendLikeEvent = (eventId, pubkey) => window.app.sendLike(eventId, pubkey);
