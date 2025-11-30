/**
 * timeline.js
 * タイムライン描画ロジック
 */

class Timeline {
  constructor(containerElement) {
    this.container = containerElement;
    this.currentTab = 'global';
    this.filterOptions = {
      flowgazerOnly: false,
      authors: null
    };
  }

  /**
   * タブを切り替え
   */
  switchTab(tab) {
    this.currentTab = tab;
    this.refresh();
  }

  /**
   * フィルターを設定
   */
  setFilter(options) {
    this.filterOptions = { ...this.filterOptions, ...options };
    this.refresh();
  }

  /**
   * タイムラインを再描画
   */
  refresh() {
    // 自動更新がOFFなら何もしない
    if (!window.app?.isAutoUpdate) {
      console.log('⏸️ 自動更新OFF: 描画スキップ');
      return;
    }

    // コンテナをクリア
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    // ViewStateから表示対象を取得
    const events = window.viewState.getVisibleEvents(this.currentTab, this.filterOptions);

    // 描画
    events.forEach(event => {
      const element = this.createEventElement(event);
      if (element) {
        this.container.appendChild(element);
      }
    });

    console.log(`📜 タイムライン描画: ${events.length}件 (${this.currentTab})`);
  }

  /**
   * イベント要素を作成
   */
  createEventElement(event) {
    switch (event.kind) {
      case 1:
        return this.createPostElement(event);
      case 6:
        return this.createRepostElement(event);
      case 7:
        return this.createLikeElement(event);
      default:
        return null;
    }
  }

  /**
   * kind:1（投稿）要素
   */
  createPostElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-post';
    li.id = event.id;

    // ふぁぼ済みなら枠を付ける
    if (window.dataStore.isLikedByMe(event.id)) {
      li.classList.add('event-liked');
    }

    // 長押しでふぁぼ
    this.attachLongPressHandler(li, event);

    // メタデータ（時刻・投稿者）
    li.appendChild(this.createMetadata(event));

    // 本文
    li.appendChild(this.createContent(event));

    // マイポストタブならリアクション数を表示
    if (this.currentTab === 'myposts') {
      const badge = this.createReactionBadge(event.id);
      if (badge) li.appendChild(badge);
    }

    return li;
  }

  /**
   * kind:6（リポスト）要素
   */
  createRepostElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-repost';

    li.appendChild(this.createMetadata(event));

    const prefix = document.createElement('span');
    prefix.textContent = 'RP: ';
    prefix.className = 'repost-prefix';
    li.appendChild(prefix);

    // 対象投稿へのリンク
    const targetId = event.tags.find(t => t[0] === 'e')?.[1];
    if (targetId) {
      const link = this.createEventLink(targetId);
      li.appendChild(link);
    }

    return li;
  }

  /**
   * kind:7（ふぁぼ）要素
   */
  createLikeElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-like';

    li.appendChild(this.createMetadata(event));

    // ふぁぼマーク
    const emoji = document.createElement('span');
    const content = (event.content && event.content !== '+') ? event.content : '⭐';
    emoji.textContent = ' ' + content + ' ';
    emoji.style.cssText = 'font-size: 1rem; margin: 0 0.25rem;';
    li.appendChild(emoji);

    // 対象投稿へのリンク
    const targetId = event.tags.find(t => t[0] === 'e')?.[1];
    if (targetId) {
      const link = this.createEventLink(targetId);
      link.textContent = '→ 投稿を見る';
      li.appendChild(link);

      // 元投稿プレビュー
      const preview = this.createOriginalPostPreview(targetId);
      li.appendChild(preview);
    }

    return li;
  }

  /**
   * メタデータ（時刻・投稿者）
   */
  createMetadata(event) {
    const span = document.createElement('span');

    // 時刻
    const time = this.createTimestamp(event);
    span.appendChild(time);
    span.appendChild(document.createTextNode(' '));

    // 投稿者
    const author = this.createAuthorLink(event.pubkey);
    span.appendChild(author);
    span.appendChild(document.createTextNode(' > '));

    return span;
  }

  /**
   * タイムスタンプリンク
   */
  createTimestamp(event) {
    const date = new Date(event.created_at * 1000);
    const timeStr = String(date.getHours()).padStart(2, '0') + ':' +
                    String(date.getMinutes()).padStart(2, '0') + ':' +
                    String(date.getSeconds()).padStart(2, '0');

    const nevent = window.NostrTools.nip19.neventEncode({
      id: event.id,
      relays: [window.relayManager.url]
    });

    const link = document.createElement('a');
    link.className = 'nostr-ref';
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nevent}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `[${timeStr}]`;

    return link;
  }

  /**
   * 投稿者リンク
   */
  createAuthorLink(pubkey) {
    const npub = window.NostrTools.nip19.npubEncode(pubkey);
    const displayName = window.dataStore.getDisplayName(pubkey);

    const link = document.createElement('a');
    link.className = 'pubkey-ref';
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${npub}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = displayName;

    // 色付け
    const hue = parseInt(pubkey.substring(0, 2), 16) * 360 / 256;
    const lightness = (hue >= 50 && hue <= 190) ? 45 : 60;
    link.style.color = `hsl(${hue}, 95%, ${lightness}%)`;

    return link;
  }

  /**
   * 投稿本文
   */
  createContent(event) {
    const div = document.createElement('div');
    div.className = 'post-content';

    // テキスト処理（URL・nostr参照・カスタム絵文字）
    const parts = this.parseContent(event.content, event.tags);
    parts.forEach(part => div.appendChild(part));

    return div;
  }

  /**
   * 本文をパース
   */
  parseContent(content, tags) {
    const pattern = /(https?:\/\/[^\s]+)|(nostr:[\w]+1[ac-hj-np-z02-9]+)|(:[_a-zA-Z0-9]+:)/;
    const parts = content.split(pattern).filter(s => s);

    return parts.map(s => {
      if (!s) return document.createTextNode('');

      // URL
      if (s.startsWith('http')) {
        return this.createUrlLink(s);
      }

      // nostr参照
      if (s.startsWith('nostr:')) {
        return this.createNostrRef(s.substring(6));
      }

      // カスタム絵文字
      if (s.startsWith(':') && s.endsWith(':')) {
        return this.createCustomEmoji(s, tags);
      }

      return document.createTextNode(s);
    });
  }

  /**
   * URLリンク
   */
  createUrlLink(url) {
    const isImage = /\.(jpeg|jpg|gif|png|webp|avif)$/i.test(url);

    if (isImage) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'nostr-ref';
      link.textContent = '[画像を表示]';
      link.onclick = (e) => {
        e.preventDefault();
        if (window.openModal) window.openModal(url);
      };
      return link;
    }

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'nostr-ref';
    link.textContent = url;
    return link;
  }

  /**
   * nostr参照
   */
  createNostrRef(nip19) {
    const link = document.createElement('a');
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nip19}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'nostr-ref';
    link.textContent = `nostr:${nip19.substring(0, 12)}...`;
    return link;
  }

  /**
   * カスタム絵文字
   */
  createCustomEmoji(shortcode, tags) {
    const name = shortcode.slice(1, -1);
    const emojiTag = tags.find(t => t[0] === 'emoji' && t[1] === name);

    if (emojiTag && emojiTag[2]) {
      const img = document.createElement('img');
      img.src = emojiTag[2];
      img.alt = shortcode;
      img.className = 'custom-emoji';
      return img;
    }

    return document.createTextNode(shortcode);
  }

  /**
   * イベントリンク
   */
  createEventLink(eventId) {
    const nevent = window.NostrTools.nip19.neventEncode({
      id: eventId,
      relays: [window.relayManager.url]
    });

    const link = document.createElement('a');
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nevent}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'nostr-ref';
    link.textContent = `nostr:${eventId.substring(0, 12)}...`;
    return link;
  }

  /**
   * 元投稿プレビュー
   */
  createOriginalPostPreview(eventId) {
    const div = document.createElement('div');
    div.className = 'original-post-preview';
    div.style.cssText = `
      margin: 0.5rem 0;
      padding: 0.5rem;
      background-color: #f0f0f0;
      border-left: 3px solid #66b3ff;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #555;
    `;

    const originalEvent = window.dataStore.events.get(eventId);

    if (originalEvent) {
      const author = document.createElement('span');
      author.style.cssText = 'font-weight: bold; color: #66b3ff;';
      author.textContent = window.dataStore.getDisplayName(originalEvent.pubkey);

      const content = document.createElement('span');
      const text = originalEvent.content.length > 150
        ? originalEvent.content.substring(0, 150) + '...'
        : originalEvent.content;
      content.textContent = ': ' + text;

      div.appendChild(author);
      div.appendChild(content);
    } else {
      div.textContent = '元投稿が見つかりませんでした';
      div.style.color = '#999';
    }

    return div;
  }

  /**
   * リアクションバッジ
   */
  createReactionBadge(eventId) {
    const counts = window.dataStore.getReactionCount(eventId);
    const parts = [];

    if (counts.reactions > 0) parts.push(`⭐${counts.reactions}`);
    if (counts.reposts > 0) parts.push(`🔁${counts.reposts}`);

    if (parts.length === 0) return null;

    const badge = document.createElement('span');
    badge.textContent = ' ' + parts.join(' ');
    badge.style.cssText = 'color: #999; margin-left: 0.5rem; font-size: 0.8rem;';
    return badge;
  }

  /**
   * 長押しハンドラー（ふぁぼ）
   */
  attachLongPressHandler(element, event) {
    let timer;

    const start = () => {
      timer = setTimeout(() => {
        if (window.sendLikeEvent) {
          if (confirm('☆ふぁぼる？')) {
            window.sendLikeEvent(event.id, event.pubkey);
          }
        }
      }, 900);
    };

    const cancel = () => clearTimeout(timer);

    element.addEventListener('mousedown', start);
    element.addEventListener('mouseup', cancel);
    element.addEventListener('mouseleave', cancel);
    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchend', cancel);
    element.addEventListener('touchcancel', cancel);
  }
}

// グローバルインスタンス（初期化は後で）
window.Timeline = Timeline;