/**
 * data-store.js
 * 【責務】: Nostrイベントとプロフィールの保存・正規化・取得状態の管理
 */

class DataStore {
  constructor() {
    // ===== 基本データ =====
    this.events = new Map(); // eventId -> event
    this.profiles = new Map(); // pubkey -> profile
    
    // ===== 管理用状態 (重複リクエスト防止用) =====
    this.pendingProfiles = new Set(); // 現在リクエスト中のpubkey
    
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
  // プロフィール管理（更新・取得・状態）
  // ========================================

  /**
   * プロフィールを追加
   * @param {string} pubkey
   * @param {Object} profileData
   * @returns {boolean} 更新された場合true
   */
  addProfile(pubkey, profileData) {
    const existing = this.profiles.get(pubkey);
    // すでに新しいデータがある場合は更新しない
    if (existing && existing.created_at >= profileData.created_at) {
      this.setProfilePending(pubkey, false); // 古いデータだった場合もリクエスト終了とする
      return false;
    }

    this.profiles.set(pubkey, profileData);
    
    // プロフィールが保存されたので、リクエスト中フラグを解除
    this.setProfilePending(pubkey, false);
    
    return true;
  }

  /**
   * プロフィールが現在リクエスト中（通信中）か確認
   * @param {string} pubkey 
   * @returns {boolean}
   */
  isProfilePending(pubkey) {
    return this.pendingProfiles.has(pubkey);
  }

  /**
   * プロフィールのリクエスト状態を設定
   * @param {string} pubkey 
   * @param {boolean} pending - 取得開始時はtrue, 完了/失敗時はfalse
   */
  setProfilePending(pubkey, pending = true) {
    if (pending) {
      this.pendingProfiles.add(pubkey);
    } else {
      this.pendingProfiles.delete(pubkey);
    }
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
   * プロフィールを取得
   */
  getProfile(pubkey) {
    return this.profiles.get(pubkey);
  }

  // ========================================
  // イベント管理
  // ========================================

  /**
   * イベントを追加 (署名検証込み)
   */
  addEvent(event) {
    if (!window.NostrTools.verifyEvent(event)) {
      console.warn('⚠️ 署名が無効なイベント:', event.id);
      return false;
    }

    if (this.events.has(event.id)) {
      return false;
    }

    this.events.set(event.id, event);
    this._categorizeEvent(event);
    return true;
  }

  _categorizeEvent(event) {
    const myPubkey = window.nostrAuth?.pubkey;

    if (!this.eventsByKind.has(event.kind)) {
      this.eventsByKind.set(event.kind, new Set());
    }
    this.eventsByKind.get(event.kind).add(event.id);

    if (!this.eventsByAuthor.has(event.pubkey)) {
      this.eventsByAuthor.set(event.pubkey, new Set());
    }
    this.eventsByAuthor.get(event.pubkey).add(event.id);

    event.tags.forEach(tag => {
      if (tag[0] === 'e' && tag[1]) {
        if (!this.eventsByReferencedEvent.has(tag[1])) {
          this.eventsByReferencedEvent.set(tag[1], new Set());
        }
        this.eventsByReferencedEvent.get(tag[1]).add(event.id);
      }
      if (tag[0] === 'p' && tag[1]) {
        if (!this.eventsByReferencedPubkey.has(tag[1])) {
          this.eventsByReferencedPubkey.set(tag[1], new Set());
        }
        this.eventsByReferencedPubkey.get(tag[1]).add(event.id);
      }
    });

    if (!myPubkey) return;
    if (event.kind === 7 && event.pubkey === myPubkey) {
      const targetEventId = event.tags.find(t => t[0] === 'e')?.[1];
      if (targetEventId) this.likedByMeIds.add(targetEventId);
    }

    if (event.kind === 6 || event.kind === 7) {
      this._updateReactionCount(event);
    }
  }

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

  getEvent(id) { return this.events.get(id); }
  getEvents(ids) { return ids.map(id => this.events.get(id)).filter(Boolean); }
  getAllEvents() { return Array.from(this.events.values()); }
  getEventIdsByKind(kind) { return this.eventsByKind.get(kind) || new Set(); }
  getEventIdsByAuthor(pubkey) { return this.eventsByAuthor.get(pubkey) || new Set(); }
  getEventIdsReferencingEvent(eventId) { return this.eventsByReferencedEvent.get(eventId) || new Set(); }
  getEventIdsReferencingPubkey(pubkey) { return this.eventsByReferencedPubkey.get(pubkey) || new Set(); }

  // ========================================
  // フォロー管理・リアクション情報・ユーティリティ
  // ========================================

  setFollowingList(pubkeys) {
    this.followingPubkeys.clear();
    pubkeys.forEach(pk => this.followingPubkeys.add(pk));
  }

  isFollowing(pubkey) { return this.followingPubkeys.has(pubkey); }
  getReactionCount(eventId) { return this.reactionCounts.get(eventId) || { reposts: 0, reactions: 0 }; }
  isLikedByMe(eventId) { return this.likedByMeIds.has(eventId); }

  getStats() {
    return {
      totalEvents: this.events.size,
      profiles: this.profiles.size,
      pendingProfiles: this.pendingProfiles.size,
      following: this.followingPubkeys.size,
      kindCounts: Object.fromEntries(Array.from(this.eventsByKind.entries()).map(([k, v]) => [k, v.size]))
    };
  }

  clear() {
    this.events.clear();
    this.profiles.clear();
    this.pendingProfiles.clear(); // クリア時にリクエスト中も消す
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
