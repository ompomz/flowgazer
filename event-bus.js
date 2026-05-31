/**
 * event-bus.js
 * 軽量EventBus：モジュール間の直接依存を解消できない箇所だけに使用する。
 *
 * 【使用イベント一覧】（ここ以外に増やさないこと）
 *
 *   auth:login-completed
 *     発火: auth-ui.js の onAuthSuccess（ログイン操作完了時）
 *     受信: app.js → onAuthSuccessFromUI() を呼ぶ
 *     理由: UIレイヤー(auth-ui)がビジネス層(app)を直接呼ぶと責務が逆転するため
 *
 *   relay:connected
 *     発火: relay-manager.js の onopen（接続成功時）
 *     受信: app.js → 現状は特に処理なし（将来の再接続後リカバリの布石）
 *     理由: 通信層(relay-manager)がアプリ制御層(app)を知るべきでないため
 *
 * 【判断基準】
 *   EventBusを使う: 「通知する側が受け取る側を知るべきでない」とき
 *   直接呼び出し : それ以外すべて（app→relayManager, app→viewState など）
 *
 * 【ルール】
 *   - ハンドラ内で emit() を呼ばない（イベントチェーンを防ぐ）
 *   - 下位層（dataStore, viewState, timeline）はここに emit しない
 *   - イベント名は必ず EVENTS 定数を使い、文字列の直書きを禁止する
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();

    /** デバッグログを出力するか */
    this.debug = false;
  }

  /**
   * イベントを購読する
   * @param {string} eventName - EVENTS 定数を使うこと
   * @param {Function} handler
   */
  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName).push(handler);
  }

  /**
   * イベントを発火する
   * @param {string} eventName - EVENTS 定数を使うこと
   * @param {*} [payload]
   */
  emit(eventName, payload) {
    const handlers = this.listeners.get(eventName);

    if (this.debug) {
      console.group(`[EventBus] emit: ${eventName}`);
      if (payload !== undefined) console.log('payload:', payload);
      console.log('handlers:', handlers?.length ?? 0);
      console.groupEnd();
    }

    if (!handlers || handlers.length === 0) return;

    handlers.forEach(handler => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] ハンドラエラー (${eventName}):`, err);
      }
    });
  }

  /**
   * 購読を解除する
   * @param {string} eventName
   * @param {Function} handler - 登録時と同じ参照を渡すこと
   */
  off(eventName, handler) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    this.listeners.set(
      eventName,
      handlers.filter(h => h !== handler)
    );
  }
}

// ========================================
// 使用するイベント名の定数（ここだけで管理）
// ========================================
const EVENTS = Object.freeze({
  /** ログイン操作完了。auth-ui.js → app.js */
  AUTH_LOGIN_COMPLETED: 'auth:login-completed',

  /** リレー接続成功。relay-manager.js → app.js */
  RELAY_CONNECTED: 'relay:connected',
});

// グローバルインスタンス
window.eventBus = new EventBus();
window.EVENTS = EVENTS;

console.log('✅ EventBus初期化完了');