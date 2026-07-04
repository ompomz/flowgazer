/**
 * relay-manager.js
 * リレー接続を一元管理するモジュール
 */

class RelayManager {
  constructor() {
    this.ws = null;
    this.url = null;
    // [変更] subId -> { filters: Array, handler: Function }
    // 旧: subId -> handler のみでフィルタを保持していなかった
    this.subscriptions = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.isConnecting = false;
  }

  /**
   * リレーに接続
   */
  async connect(url) {
    if (this.ws?.readyState === WebSocket.OPEN && this.url === url) {
      console.log('✅ すでに接続済み:', url);
      return Promise.resolve();
    }

    // 既存接続をクリーンアップ
    if (this.ws) {
      this.disconnect();
    }

    this.url = url;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          console.log('✅ リレー接続成功:', url);
          this.isConnecting = false;
          this.reconnectAttempts = 0;

          // 既存の購読を再開
          this.resubscribeAll();

          // [追加] 接続成功をアプリ層に通知（通信層はアプリ層を直接知らないためバス経由）
          window.eventBus?.emit(window.EVENTS.RELAY_CONNECTED, { url });

          resolve();
        };

        this.ws.onmessage = (ev) => {
          this.handleMessage(ev.data);
        };

        this.ws.onerror = (err) => {
          console.error('❌ リレー接続エラー:', url, err);
          this.isConnecting = false;
          reject(err);
        };

        this.ws.onclose = () => {
          console.warn('⚠️ リレー接続切断:', url);
          this.isConnecting = false;
          this.attemptReconnect();
        };

        // 接続タイムアウト（5秒）
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close();
            reject(new Error('接続タイムアウト'));
          }
        }, 5000);

      } catch (err) {
        console.error('❌ WebSocket作成エラー:', err);
        this.isConnecting = false;
        reject(err);
      }
    });
  }

  /**
   * メッセージハンドラー
   */
  handleMessage(data) {
    try {
      const [type, subId, event] = JSON.parse(data);
      // [変更] subscriptions の値が { filters, handler } になったため .handler を参照
      const sub = this.subscriptions.get(subId);

      if (sub) {
        sub.handler(type, event, subId);
      }

    } catch (err) {
      console.error('❌ メッセージ処理エラー:', err);
    }
  }

  /**
   * イベントを購読
   *
   * @param {string}          subId    - 購読ID（一意な文字列）
   * @param {Object|Object[]} filters  - Nostr フィルタ
   * @param {Function}        handler  - イベントハンドラ (type, event) => void
   * @param {Object}          [options]
   * @param {boolean}         [options.persistent=false]
   *   true のとき「永続購読」として扱い、再接続時に REQ を自動再送する。
   *   false（デフォルト）のとき「一時購読」として扱い、再接続時に破棄される。
   *   永続購読にすべき例: stream-phase / stream-channel / following-list / my-likes
   *   一時購読にすべき例: anchor-phase / load-more-* / channel-history-*
   */
  subscribe(subId, filters, handler, { persistent = false } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ リレー未接続のため購読できません');
      return false;
    }

    // フィルターの正規化（配列化）
    const filterArray = Array.isArray(filters) ? filters : [filters];

    // フィルタ・ハンドラ・永続フラグをセットで保持する
    this.subscriptions.set(subId, { filters: filterArray, handler, persistent });

    // REQメッセージを送信
    const reqMsg = ['REQ', subId, ...filterArray];
    this.ws.send(JSON.stringify(reqMsg));

    console.log('📡 購読開始:', subId, filterArray);
    return true;
  }

  /**
   * 購読を解除
   */
  unsubscribe(subId) {
    // 切断中でも内部状態は必ず削除する
    const existed = this.subscriptions.has(subId);
    this.subscriptions.delete(subId);

    if (!existed) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(['CLOSE', subId]));
    }

    console.log('📡 購読解除:', subId);
  }

  /**
   * すべての購読を解除
   */
  unsubscribeAll() {
    const subIds = Array.from(this.subscriptions.keys());
    subIds.forEach(subId => this.unsubscribe(subId));
  }

  /**
   * 永続購読を再開（再接続時用）
   *
   * persistent: true で登録された購読のみ REQ を再送する。
   * persistent: false の一時購読は Map から除去して破棄する。
   * 再接続後に必要な一時購読は app.js 側で改めて起動される。
   */
  resubscribeAll() {
    if (this.subscriptions.size === 0) {
      console.log('🔄 再購読対象なし');
      return;
    }

    console.log(`🔄 購読を再開します... (${this.subscriptions.size}件)`);

    // パス1: 一時購読（persistent: false）を Map から除去
    const transientIds = [];
    this.subscriptions.forEach(({ persistent }, subId) => {
      if (!persistent) transientIds.push(subId);
    });
    transientIds.forEach(subId => {
      this.subscriptions.delete(subId);
      console.log(`🔄 一時購読を破棄: ${subId}`);
    });

    // パス2: 永続購読の REQ を再送
    this.subscriptions.forEach(({ filters }, subId) => {
      const reqMsg = ['REQ', subId, ...filters];
      this.ws.send(JSON.stringify(reqMsg));
      console.log('🔄 購読再開:', subId);
    });
  }

  /**
   * 再接続を試みる
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ 再接続の上限に達しました');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);

    console.log(`🔄 ${delay}ms後に再接続を試みます... (試行 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.url) {
        this.connect(this.url).catch(err => {
          console.error('再接続失敗:', err);
        });
      }
    }, delay);
  }

  /**
   * 切断
   */
  disconnect() {
    if (this.ws) {
      this.unsubscribeAll();
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.url = null;
    console.log('🔌 リレーから切断しました');
  }

  /**
   * 接続状態を取得
   */
  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * イベントを送信（投稿・ふぁぼなど）
   */
  publish(event) {
    if (!this.isConnected()) {
      throw new Error('リレーに接続されていません');
    }

    this.ws.send(JSON.stringify(['EVENT', event]));
    console.log('📤 イベント送信:', event.kind);
  }
}

// グローバルインスタンス
window.relayManager = new RelayManager();
console.log('✅ RelayManager初期化完了');