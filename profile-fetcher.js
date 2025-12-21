class ProfileFetcher {
  constructor() {
    this.queue = new Set();          // 取得待ちpubkey
    this.timer = null;
    this.batchDelay = 500;           // バッチ処理の遅延（ms）
    this.maxBatchSize = 100;         // 一度に取得する最大数
  }

  /**
   * プロファイル取得をリクエスト
   */
  request(pubkey) {
    // 1. 既にデータがある場合はスキップ
    if (window.dataStore && window.dataStore.getProfile(pubkey)) {
      return;
    }

    // 2. DataStore側で「取得中」マークが付いているならスキップ（ここが重要！）
    if (window.dataStore && window.dataStore.isProfilePending(pubkey)) {
      return;
    }

    // キューに追加
    this.queue.add(pubkey);
    this.scheduleFlush();
  }

  /**
   * 複数のpubkeyをまとめてリクエスト
   */
  requestMultiple(pubkeys) {
    pubkeys.forEach(pk => this.request(pk));
  }

  /**
   * フラッシュをスケジュール
   */
  scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.batchDelay);
  }

  /**
   * キューをフラッシュして実際に取得
   */
  async flush() {
    if (this.queue.size === 0) return;

    // キューから取得対象を取り出し
    const pubkeys = Array.from(this.queue).slice(0, this.maxBatchSize);
    pubkeys.forEach(pk => this.queue.delete(pk));

    // 3. 取得開始マークを付ける (DataStore側)
    if (window.dataStore) {
        pubkeys.forEach(pk => window.dataStore.setProfilePending(pk, true));
    }

    console.log(`👤 プロファイルをバッチ取得開始: ${pubkeys.length}件`);

    // 購読ID
    const subId = 'profiles-' + Date.now();

    // ハンドラー
    const handler = (type, event) => {
      if (type === 'EVENT' && event.kind === 0) {
        try {
          const profile = JSON.parse(event.content);
          if (window.dataStore && typeof window.dataStore.addProfile === 'function') {
            // ここで addProfile を呼ぶと、DataStore内で自動的に Pending が解除されます
            window.dataStore.addProfile(event.pubkey, {
              ...profile,
              created_at: event.created_at
            });
          }
        } catch (err) {
          console.error('❌ プロファイルパースエラー:', err);
          // エラー時も一応フラグを解除しておかないと次が取れなくなるためケア
          if (window.dataStore) window.dataStore.setProfilePending(event.pubkey, false);
        }

      } else if (type === 'EOSE') {
        // 購読解除
        window.relayManager.unsubscribe(subId);
        
        // 4. EOSEが来た時点で、データが返ってこなかったpubkeyの Pending を解除
        if (window.dataStore) {
            pubkeys.forEach(pk => {
                // まだ profiles に入っていない ＝ 見つからなかった人
                if (!window.dataStore.getProfile(pk)) {
                    window.dataStore.setProfilePending(pk, false);
                }
            });
        }

        // 更新判定
        const hasNewData = pubkeys.some(pk => 
          window.dataStore && window.dataStore.getProfile(pk)
        );

        if (hasNewData) {
          console.log(`✅ 新規プロファイルを取得したため、更新通知を送ります`);
          document.dispatchEvent(new CustomEvent('profiles_updated'));
          if (window.timeline && typeof window.timeline.refresh === 'function') {
            window.timeline.refresh();
          }
        }
      }
    };

    // 購読開始
    if (window.relayManager && typeof window.relayManager.subscribe === 'function') {
      window.relayManager.subscribe(subId, {
        kinds: [0],
        authors: pubkeys
      }, handler);
    }
  }

  /**
   * 即座にフラッシュ
   */
  flushNow() {
    clearTimeout(this.timer);
    this.flush();
  }
}

window.profileFetcher = new ProfileFetcher();
