/**
 * data-store.js
 * 【責務】: Nostrイベントとプロフィールの保存・正規化のみ
 */

class DataStore {
  constructor() {
    // ===== 基本データ =====
    this.events = new Map(); // eventId -> event
    this.profiles = new Map(); // pubkey -> profile
    
    // ===== カテゴリ分類 (シンプルな分類のみ) =====
    this.eventsByKind = new Map(); // kind -> Set<eventId>
    this.eventsByAuthor = new Map(); // pubkey -> Set<eventId>
    this.eventsByReferencedEvent = new Map(); // eventId -> Set<eventId> (eタグ)
    this.eventsByReferencedPubkey = new Map(); // pubkey -> Set<eventId> (pタグ)
    
    // ===== ユーザー固有のデータ =====
    this.followingPubkeys = new Set(); // フォロー中のpubkey
    this.likedByMeIds = new Set(); // 自分がふぁぼった投稿ID
    
    // ===== リアクションカウント =====
    this.reactionCounts = new Map(); // eventId -> { reposts: 0, reactions: 0 }
    
    console.log('✅ DataStore初期化完了');
  }

  // ========================================
  // イベント管理
  // ========================================

  /**
   * イベントを追加 (署名検証込み)
   * @param {Object} event - Nostrイベント
   * @returns {boolean} 新規追加された場合true
   */
  addEvent(event) {
    // 署名検証
    if (!window.NostrTools.verifyEvent(event)) {
      console.warn('⚠️ 署名が無効なイベント:', event.id);
      return false;
    }

    // 既存チェック
    if (this.events.has(event.id)) {
      return false;
    }

    // 保存
    this.events.set(event.id, event);

    // カテゴリ分類
    this._categorizeEvent(event);

    return true;
  }

  /**
   * イベントをカテゴリ分類 (インデックス作成のみ)
   * @private
   */
  _categorizeEvent(event) {
    const myPubkey = window.nostrAuth?.pubkey;

    // kind別インデックス
    if (!this.eventsByKind.has(event.kind)) {
      this.eventsByKind.set(event.kind, new Set());
    }
    this.eventsByKind.get(event.kind).add(event.id);

    // 投稿者別インデックス
    if (!this.eventsByAuthor.has(event.pubkey)) {
      this.eventsByAuthor.set(event.pubkey, new Set());
    }
    this.eventsByAuthor.get(event.pubkey).add(event.id);

    // eタグ (参照イベント) インデックス
    event.tags.forEach(tag => {
      if (tag[0] === 'e' && tag[1]) {
        if (!this.eventsByReferencedEvent.has(tag[1])) {
          this.eventsByReferencedEvent.set(tag[1], new Set());
        }
        this.eventsByReferencedEvent.get(tag[1]).add(event.id);
      }
    });

    // pタグ (参照ユーザー) インデックス
    event.tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        if (!this.eventsByReferencedPubkey.has(tag[1])) {
          this.eventsByReferencedPubkey.set(tag[1], new Set());
        }
        this.eventsByReferencedPubkey.get(tag[1]).add(event.id);
      }
    });

    // === ユーザー固有の分類 ===
    if (!myPubkey) return;

    // 自分がふぁぼったイベント
    if (event.kind === 7 && event.pubkey === myPubkey) {
      const targetEventId = event.tags.find(t => t[0] === 'e')?.[1];
      if (targetEventId) {
        this.likedByMeIds.add(targetEventId);
      }
    }

    // リアクションカウント更新
    if (event.kind === 6 || event.kind === 7) {
      this._updateReactionCount(event);
    }
  }

  /**
   * リアクション数を更新
   * @private
   */
  _updateReactionCount(event) {
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
   * イベントを取得
   * @param {string} id - イベントID
   * @returns {Object|undefined}
   */
  getEvent(id) {
    return this.events.get(id);
  }

  /**
   * 複数のイベントを取得
   * @param {string[]} ids - イベントIDの配列
   * @returns {Object[]} イベントの配列
   */
  getEvents(ids) {
    return ids.map(id => this.events.get(id)).filter(Boolean);
  }

  /**
   * すべてのイベントを取得
   * @returns {Object[]}
   */
  getAllEvents() {
    return Array.from(this.events.values());
  }

  /**
   * kind別のイベントIDを取得
   * @param {number} kind
   * @returns {Set<string>}
   */
  getEventIdsByKind(kind) {
    return this.eventsByKind.get(kind) || new Set();
  }

  /**
   * 投稿者別のイベントIDを取得
   * @param {string} pubkey
   * @returns {Set<string>}
   */
  getEventIdsByAuthor(pubkey) {
    return this.eventsByAuthor.get(pubkey) || new Set();
  }

  /**
   * 特定イベントを参照しているイベントIDを取得 (eタグ)
   * @param {string} eventId
   * @returns {Set<string>}
   */
  getEventIdsReferencingEvent(eventId) {
    return this.eventsByReferencedEvent.get(eventId) || new Set();
  }

  /**
   * 特定ユーザーを参照しているイベントIDを取得 (pタグ)
   * @param {string} pubkey
   * @returns {Set<string>}
   */
  getEventIdsReferencingPubkey(pubkey) {
    return this.eventsByReferencedPubkey.get(pubkey) || new Set();
  }

  // ========================================
  // プロフィール管理
  // ========================================

  /**
   * プロフィールを追加
   * @param {string} pubkey
   * @param {Object} profileData
   * @returns {boolean} 更新された場合true
   */
  addProfile(pubkey, profileData) {
    const existing = this.profiles.get(pubkey);
    if (existing && existing.created_at >= profileData.created_at) {
      return false;
    }

    this.profiles.set(pubkey, profileData);
    return true;
  }

  /**
   * プロフィール表示名を取得
   * @param {string} pubkey
   * @returns {string}
   */
  getDisplayName(pubkey) {
    const profile = this.profiles.get(pubkey);

    // 1. nameがあればそれを使用
    if (profile?.name) {
      return profile.name;
    }

    // 2. display_nameがあればそれを使用
    if (profile?.display_name) {
      return profile.display_name;
    }

    // 3. nip05があればドメイン部分を使用
    if (profile?.nip05) {
      const atIndex = profile.nip05.indexOf('@');
      if (atIndex !== -1) {
        return profile.nip05.substring(atIndex + 1);
      }
    }

    // 4. どれもない場合はhexpubkeyを短縮
    return pubkey.substring(0, 8);
  }

  /**
   * プロフィールを取得
   * @param {string} pubkey
   * @returns {Object|undefined}
   */
  getProfile(pubkey) {
    return this.profiles.get(pubkey);
  }
  
    /**
   * 指定した pubkey の最新の kind:X イベントを返す
   * @param {string} pubkey
   * @param {number} kind
   * @returns {Object|null}
   */
  getLatestEventByKind(pubkey, kind) {
    const eventIds = this.eventsByAuthor.get(pubkey);
    if (!eventIds) return null;

    let latest = null;

    for (const id of eventIds) {
      const ev = this.events.get(id);
      if (ev && ev.kind === kind) {
        if (!latest || ev.created_at > latest.created_at) {
          latest = ev;
        }
      }
    }

    return latest;
  }

  // ========================================
  // フォロー管理
  // ========================================

  /**
   * フォローリストを設定
   * @param {string[]} pubkeys
   */
  setFollowingList(pubkeys) {
    this.followingPubkeys.clear();
    pubkeys.forEach(pk => this.followingPubkeys.add(pk));
    console.log(`👥 フォロー中: ${this.followingPubkeys.size}人`);
  }

  /**
   * フォロー中かチェック
   * @param {string} pubkey
   * @returns {boolean}
   */
  isFollowing(pubkey) {
    return this.followingPubkeys.has(pubkey);
  }

  // ========================================
  // リアクション情報
  // ========================================

  /**
   * リアクション数を取得
   * @param {string} eventId
   * @returns {Object} { reposts: number, reactions: number }
   */
  getReactionCount(eventId) {
    return this.reactionCounts.get(eventId) || { reposts: 0, reactions: 0 };
  }

  /**
   * ふぁぼ済みかチェック
   * @param {string} eventId
   * @returns {boolean}
   */
  isLikedByMe(eventId) {
    return this.likedByMeIds.has(eventId);
  }

  // ========================================
  // ユーティリティ
  // ========================================

  /**
   * 統計情報を取得
   * @returns {Object}
   */
  getStats() {
    return {
      totalEvents: this.events.size,
      profiles: this.profiles.size,
      following: this.followingPubkeys.size,
      kindCounts: Object.fromEntries(
        Array.from(this.eventsByKind.entries()).map(([k, v]) => [k, v.size])
      )
    };
  }

  /**
   * すべてのデータをクリア
   */
  clear() {
    this.events.clear();
    this.profiles.clear();
    this.eventsByKind.clear();
    this.eventsByAuthor.clear();
    this.eventsByReferencedEvent.clear();
    this.eventsByReferencedPubkey.clear();
    this.followingPubkeys.clear();
    this.likedByMeIds.clear();
    this.reactionCounts.clear();
    console.log('🗑️ データストアをクリアしました');
  }
}

// グローバルインスタンス
window.dataStore = new DataStore();
console.log('✅ DataStore初期化完了');
