/**
 * data-store.js
 * すべてのNostrデータを一元管理するストア
 */

class DataStore {
  constructor() {
    // 全イベントを保存（kind:1, 6, 7）
    this.events = new Map(); // eventId -> event

    // プロフィール情報
    this.profiles = new Map(); // pubkey -> profile

    // カテゴリ別のイベントID管理
    this.myPostIds = new Set();           // 自分の投稿
    this.receivedLikeIds = new Set();     // 自分が受け取ったkind:7
    this.followingPubkeys = new Set();    // フォロー中のpubkey
    this.likedByMeIds = new Set();        // 自分がふぁぼった投稿ID

    // リアクションカウント
    this.reactionCounts = new Map(); // eventId -> { reposts: 0, reactions: 0 }

    // タブ別の最古タイムスタンプ
    this.oldestTimestamps = {
      global: Date.now() / 1000,
      following: Date.now() / 1000,
      myposts: Date.now() / 1000,
      likes: Date.now() / 1000
    };
  }

  /**
   * イベントを追加
   */
  addEvent(event) {
    // 既存チェック
    if (this.events.has(event.id)) {
      return false;
    }

    // 署名検証
    if (!window.NostrTools.verifyEvent(event)) {
      console.warn('⚠️ 署名が無効なイベント:', event.id);
      return false;
    }

    // 保存
    this.events.set(event.id, event);

    // カテゴリ分け
    this.categorizeEvent(event);

    // タブ別の最古タイムスタンプを更新
    this.updateOldestTimestamps(event);

    return true;
  }

  /**
   * タブ別の最古タイムスタンプを更新
   */
  updateOldestTimestamps(event) {
    const myPubkey = window.nostrAuth?.pubkey;

    // kind:1, 6のみ対象
    if (event.kind !== 1 && event.kind !== 6) return;

    // グローバル
    if (event.created_at < this.oldestTimestamps.global) {
      this.oldestTimestamps.global = event.created_at;
    }

    // フォロー中
    if (this.followingPubkeys.has(event.pubkey)) {
      if (event.created_at < this.oldestTimestamps.following) {
        this.oldestTimestamps.following = event.created_at;
      }
    }

    // 自分の投稿
    if (event.kind === 1 && event.pubkey === myPubkey) {
      if (event.created_at < this.oldestTimestamps.myposts) {
        this.oldestTimestamps.myposts = event.created_at;
      }
    }
  }

  /**
   * イベントをカテゴリ分け
   */
  categorizeEvent(event) {
    const myPubkey = window.nostrAuth?.pubkey;

    // 自分の投稿
    if (event.kind === 1 && event.pubkey === myPubkey) {
      this.myPostIds.add(event.id);
    }

    // 自分が受け取ったkind:7
    if (event.kind === 7) {
      const targetPubkey = event.tags.find(t => t[0] === 'p')?.[1];
      if (targetPubkey === myPubkey) {
        this.receivedLikeIds.add(event.id);
      }

      // 自分がふぁぼったやつ
      if (event.pubkey === myPubkey) {
        const targetEventId = event.tags.find(t => t[0] === 'e')?.[1];
        if (targetEventId) {
          this.likedByMeIds.add(targetEventId);
        }
      }

      // リアクションカウント
      this.updateReactionCount(event);
    }

    // kind:6（リポスト）のカウント
    if (event.kind === 6) {
      this.updateReactionCount(event);
    }
  }

  /**
   * リアクション数を更新
   */
  updateReactionCount(event) {
    const targetId = event.tags.find(t => t[0] === 'e')?.[1];
    if (!targetId) return;

    if (!this.reactionCounts.has(targetId)) {
      this.reactionCounts.set(targetId, { reposts: 0, reactions: 0 });
    }

    const counts = this.reactionCounts.get(targetId);
    if (event.kind === 6) {
      counts.reposts++;
    } else if (event.kind === 7) {
      counts.reactions++;
    }
  }

  /**
   * プロフィールを追加
   */
  addProfile(pubkey, profileData) {
    // 既存プロフィールより古い場合はスキップ
    const existing = this.profiles.get(pubkey);
    if (existing && existing.created_at >= profileData.created_at) {
      return false;
    }

    this.profiles.set(pubkey, profileData);
    return true;
  }

  /**
   * フォローリストを設定
   */
  setFollowingList(pubkeys) {
    this.followingPubkeys.clear();
    pubkeys.forEach(pk => this.followingPubkeys.add(pk));
    console.log(`👥 フォロー中: ${this.followingPubkeys.size}人`);
  }

  /**
   * タブ別のイベントを取得
   */
  getEventsByTab(tab, filterOptions = {}) {
    const { flowgazerOnly = false } = filterOptions;
    let eventIds = [];

    switch (tab) {
      case 'global':
        // 全イベント（kind:1, 6）
        eventIds = Array.from(this.events.keys())
          .filter(id => {
            const ev = this.events.get(id);
            return ev.kind === 1 || ev.kind === 6;
          });
        break;

      case 'following':
        // フォロー中のユーザーの投稿
        eventIds = Array.from(this.events.keys())
          .filter(id => {
            const ev = this.events.get(id);
            return (ev.kind === 1 || ev.kind === 6) && 
                   this.followingPubkeys.has(ev.pubkey);
          });
        break;

      case 'myposts':
        // 自分の投稿
        eventIds = Array.from(this.myPostIds);
        break;

      case 'likes':
        // 自分が受け取ったkind:7
        eventIds = Array.from(this.receivedLikeIds);
        break;

      default:
        return [];
    }

    // flowgazerしぼりこみ
    if (flowgazerOnly && tab !== 'likes') {
      eventIds = eventIds.filter(id => {
        const ev = this.events.get(id);
        return ev.kind === 1 && 
               ev.tags.some(tag => tag[0] === 'client' && tag[1] === 'flowgazer');
      });
    }

    // イベントオブジェクトを取得してソート
    return eventIds
      .map(id => this.events.get(id))
      .filter(Boolean)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * 投稿者しぼりこみ
   */
  filterByAuthors(events, authorPubkeys) {
    if (!authorPubkeys || authorPubkeys.length === 0) {
      return events;
    }

    const authorSet = new Set(authorPubkeys);
    return events.filter(ev => authorSet.has(ev.pubkey));
  }

  /**
   * プロフィール表示名を取得
   */
  getDisplayName(pubkey) {
    const profile = this.profiles.get(pubkey);
    if (profile?.name) {
      return profile.name;
    }
    return pubkey.substring(0, 8);
  }

  /**
   * リアクション数を取得
   */
  getReactionCount(eventId) {
    return this.reactionCounts.get(eventId) || { reposts: 0, reactions: 0 };
  }

  /**
   * タブ別の最古タイムスタンプを取得
   */
  getOldestTimestamp(tab) {
    return this.oldestTimestamps[tab] || Date.now() / 1000;
  }

  /**
   * ふぁぼ済みかチェック
   */
  isLikedByMe(eventId) {
    return this.likedByMeIds.has(eventId);
  }

  /**
   * クリア
   */
  clear() {
    this.events.clear();
    this.profiles.clear();
    this.myPostIds.clear();
    this.receivedLikeIds.clear();
    this.followingPubkeys.clear();
    this.likedByMeIds.clear();
    this.reactionCounts.clear();
    const now = Date.now() / 1000;
    this.oldestTimestamps = {
      global: now,
      following: now,
      myposts: now,
      likes: now
    };
    console.log('🗑️ データストアをクリアしました');
  }

  /**
   * 統計情報
   */
  getStats() {
    return {
      totalEvents: this.events.size,
      profiles: this.profiles.size,
      myPosts: this.myPostIds.size,
      receivedLikes: this.receivedLikeIds.size,
      following: this.followingPubkeys.size
    };
  }
}

// グローバルインスタンス
window.dataStore = new DataStore();
console.log('✅ DataStore初期化完了');