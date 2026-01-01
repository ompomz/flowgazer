/**
 * timeline.js
 * 【責務】: DOM要素の生成とレンダリング・適切なクリーンアップ
 */

// ===== ユーティリティ（表示名用） =====

function lenb(str) {
  let length = 0;
  for (const char of str) {
    length += /[^\x01-\x7E]/.test(char) ? 2 : 1;
  }
  return length;
}

function truncateByLenb(str, maxLenb) {
  let result = '';
  let currentLenb = 0;

  for (const char of str) {
    const charLen = /[^\x01-\x7E]/.test(char) ? 2 : 1;

    if (currentLenb + charLen + 1 > maxLenb) {
      return result + '…';
    }

    result += char;
    currentLenb += charLen;
  }
  return result;
}

function hexToHue(hex6) {
  const r = parseInt(hex6.slice(0, 2), 16) / 255;
  const g = parseInt(hex6.slice(2, 4), 16) / 255;
  const b = parseInt(hex6.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return Math.round(h);
}

// ===== Timeline クラス =====

class Timeline {
  constructor(containerElement) {
    this.container = containerElement;
    this.currentTab = 'global';
    
    // DOM要素の追跡用
    this.activeElements = new Set();
    
    // フィルターオプション
    this.filterOptions = {
      flowgazerOnly: false,
      authors: null
    };
  }

  // ========================================
  // タブ管理
  // ========================================

  switchTab(tab) {
    this.currentTab = tab;
    this.refresh();
  }

  setFilter(options) {
    this.filterOptions = { ...this.filterOptions, ...options };
    this.refresh();
  }

  // ========================================
  // レンダリング
  // ========================================

  refresh() {
    if (!window.app?.isAutoUpdate) {
      console.log('⏸️ 自動更新OFF: 描画スキップ');
      return;
    }

    // 既存の要素をすべてクリーンアップ
    this.destroyAllElements();

    // ViewStateから表示対象を取得
    const events = window.viewState.getVisibleEvents(this.currentTab, this.filterOptions);

    // 描画
    events.forEach(event => {
      const element = this.createEventElement(event);
      if (element) {
        this.container.appendChild(element);
        this.activeElements.add(element);
      }
    });

    console.log(`📜 タイムライン描画: ${events.length}件 (${this.currentTab})`);
  }

  /**
   * すべてのアクティブな要素を破棄
   */
  destroyAllElements() {
    this.activeElements.forEach(element => {
      if (element.destroy) {
        element.destroy();
      }
    });
    this.activeElements.clear();
    
    // コンテナをクリア
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }

  // ========================================
  // イベント要素作成
  // ========================================

  createEventElement(event) {
    switch (event.kind) {
      case 1:
        return this.createPostElement(event);
      case 6:
        return this.createRepostElement(event);
      case 7:
        return this.createLikeElement(event);
      case 42:
        return this.createChannelMessageElement(event);
      default:
        return null;
    }
  }

  /**
   * kind:42 (チャンネルメッセージ) 要素
   */
  createChannelMessageElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-channel';
    li.id = event.id;

    // 長押しハンドラー
    const longPressHandler = this.createLongPressHandler(event);
    longPressHandler.attach(li);

    // destroy メソッド
    li.destroy = () => {
      longPressHandler.detach();
      li.remove();
    };

    // メタデータ
    li.appendChild(this.createMetadata(event));

    // チャンネルマーク
    const badge = document.createElement('span');
    badge.textContent = '*kind:42 ';
    badge.style.cssText = 'color: #B3A1FF; font-weight: normal;';
    li.appendChild(badge);

    // 本文
    li.appendChild(this.createContent(event));

    return li;
  }

  /**
   * kind:1 (投稿) 要素
   */
  createPostElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-post';
    li.id = event.id;

    if (window.dataStore.isLikedByMe(event.id)) {
      li.classList.add('event-liked');
    }

    // 長押しハンドラー
    const longPressHandler = this.createLongPressHandler(event);
    longPressHandler.attach(li);

    // destroy メソッド
    li.destroy = () => {
      longPressHandler.detach();
      li.remove();
    };

    // メタデータ
    li.appendChild(this.createMetadata(event));

    // 本文
    const cwTag = event.tags.find(tag => tag[0] === "content-warning");

    if (cwTag) {
      const reason = cwTag[1] ? `：${cwTag[1]}` : "";

      // ボタンではなく <a> タグで作る
      const cwLink = document.createElement('a');
      cwLink.href = '#';
      cwLink.className = 'nostr-ref';
      cwLink.textContent = `⚠️${reason} [内容を表示]`;

      cwLink.onclick = (e) => {
        e.preventDefault();  // URLに飛ばないようにする
        e.stopPropagation(); // 他のイベントと重ならないようにする

        const content = this.createContent(event);
        cwLink.replaceWith(content);
      };

      li.appendChild(cwLink);
    } else {
      li.appendChild(this.createContent(event));
    }

    // リアクションバッジ
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

    li.destroy = () => {
      li.remove();
    };

    li.appendChild(this.createMetadata(event));

    const prefix = document.createElement('span');
    prefix.textContent = 'RT: ';
    prefix.className = 'repost-prefix';
    li.appendChild(prefix);

    const targetId = event.tags.find(t => t[0] === 'e')?.[1];
    if (targetId) {
      const originalEvent = window.dataStore.getEvent(targetId);
      if (originalEvent) {
        // 元の投稿が存在する場合
        const ts = this.createTimestamp(originalEvent);
        li.appendChild(ts);
        li.appendChild(document.createTextNode(' '));
        const authorLink = this.createAuthorLink(originalEvent.pubkey);
        li.appendChild(authorLink);

        const contentWrapper = document.createElement('span');
        contentWrapper.className = 'repost-content';
        contentWrapper.appendChild(document.createTextNode(' > '));

        // createContent を使うことで、リンク化やCW判定が自動で適用されます
        const richContent = this.createContent(originalEvent);
        
        contentWrapper.appendChild(richContent);
        li.appendChild(contentWrapper);
      } else {
        // 元の投稿が見つからない場合はリンクを表示
        const link = this.createEventLink(targetId);
        li.appendChild(link);
      }
    }

    return li;
  }

  /**
   * kind:7 (ふぁぼ) 要素
   */
  createLikeElement(event) {
    const li = document.createElement('li');
    li.className = 'event event-like';

    // 長押しハンドラー
    const longPressHandler = this.createLongPressHandler(event);
    longPressHandler.attach(li);

    // destroy メソッド
    li.destroy = () => {
      longPressHandler.detach();
      li.remove();
    };

    li.appendChild(this.createMetadata(event));

    // カスタム絵文字処理
    const content = event.content || '+';
    const isCustomEmoji = content.startsWith(':') && content.endsWith(':') && content.length > 2;

    if (isCustomEmoji) {
      const emojiElement = this.createCustomEmoji(content, event.tags);
      emojiElement.style.cssText = 'height: 1.5rem; vertical-align: middle; margin: 0 0.25rem;';
      li.appendChild(document.createTextNode(' '));
      li.appendChild(emojiElement);
      li.appendChild(document.createTextNode(' '));
    } else {
      const emoji = document.createElement('span');
      const displayContent = (content && content !== '+') ? content : '⭐';
      emoji.textContent = ' ' + displayContent + ' ';
      emoji.style.cssText = 'font-size: 1rem; margin: 0 0.25rem;';
      li.appendChild(emoji);
    }

    // 対象投稿へのリンク
    const targetId = event.tags.find(t => t[0] === 'e')?.[1];
    if (targetId) {
      const link = this.createEventLink(targetId);
      link.textContent = '→ 投稿を見る';
      li.appendChild(link);

      const preview = this.createOriginalPostPreview(targetId);
      li.appendChild(preview);
    }

    return li;
  }

  // ========================================
  // 長押しハンドラー（オブジェクト化）
  // ========================================

  /**
   * 長押しハンドラーオブジェクトを作成
   * @param {Object} event - Nostrイベント
   * @returns {Object} { attach, detach }
   */
  createLongPressHandler(event) {
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

    return {
      attach(element) {
        element.addEventListener('mousedown', start);
        element.addEventListener('mouseup', cancel);
        element.addEventListener('mouseleave', cancel);
        element.addEventListener('touchstart', start, { passive: true });
        element.addEventListener('touchend', cancel);
        element.addEventListener('touchcancel', cancel);
        
        // ハンドラー参照を保存（detach用）
        element._longPressHandlers = { start, cancel };
      },

      detach() {
        const element = this.element;
        if (!element || !element._longPressHandlers) return;
        
        const { start, cancel } = element._longPressHandlers;
        element.removeEventListener('mousedown', start);
        element.removeEventListener('mouseup', cancel);
        element.removeEventListener('mouseleave', cancel);
        element.removeEventListener('touchstart', start);
        element.removeEventListener('touchend', cancel);
        element.removeEventListener('touchcancel', cancel);
        
        delete element._longPressHandlers;
        clearTimeout(timer);
      },
      
      // 後で detach するために element を保持
      element: null
    };
  }

  // ========================================
  // 共通要素作成（変更なし）
  // ========================================

  createMetadata(event) {
    const span = document.createElement('span');
    const time = this.createTimestamp(event);
    span.appendChild(time);
    span.appendChild(document.createTextNode(' '));
    const author = this.createAuthorLink(event.pubkey);
    span.appendChild(author);
    span.appendChild(document.createTextNode(' > '));
    return span;
  }

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

  createAuthorLink(pubkey) {
    const npub = window.NostrTools.nip19.npubEncode(pubkey);
    const displayName = window.dataStore.getDisplayName(pubkey);

    const link = document.createElement('a');
    link.className = 'pubkey-ref';
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${npub}`;
    link.target = '_blank';
    link.rel = 'noreferrer';

    let truncatedName = displayName;
    if (lenb(displayName) >= 23) {
      truncatedName = truncateByLenb(displayName, 20);
    }
    link.textContent = truncatedName;

    const hex6 = pubkey.substring(0, 6);
    const hue = hexToHue(hex6);

    const lightness = (hue >= 50 && hue <= 190) ? 45 : 60;
    link.style.color = `hsl(${hue}, 95%, ${lightness}%)`;

    return link;
  }

  createContent(event) {
    const div = document.createElement('div');
    div.className = 'post-content';

    const parts = this.parseContent(event.content, event.tags);
    parts.forEach(part => div.appendChild(part));

    return div;
  }

  parseContent(content, tags) {
    const pattern = /(https?:\/\/[^\s]+)|(nostr:[\w]+1[ac-hj-np-z02-9]+)|(:[_a-zA-Z0-9]+:)/;
    const parts = content.split(pattern).filter(s => s);

    return parts.map(s => {
      if (!s) return document.createTextNode('');

      if (s.startsWith('http')) {
        return this.createUrlLink(s);
      }

      if (s.startsWith('nostr:')) {
        return this.createNostrRef(s.substring(6));
      }

      if (s.startsWith(':') && s.endsWith(':')) {
        return this.createCustomEmoji(s, tags);
      }

      return document.createTextNode(s);
    });
  }

  createUrlLink(url) {
    const isImage = /\.(jpeg|jpg|gif|png|webp|avif)$/i.test(url);
    const isVideo = /\.(mp4|webm|ogv|mov)$/i.test(url);

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

    if (isVideo) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'nostr-ref';
      link.textContent = '[動画を表示]';
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

  createNostrRef(nip19) {
    const link = document.createElement('a');
    link.href = `https://ompomz.github.io/tweetsrecap/tweet?id=${nip19}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'nostr-ref';
    link.textContent = `nostr:${nip19.substring(0, 12)}...`;
    return link;
  }

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

    const originalEvent = window.dataStore.getEvent(eventId);

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
   * タイムライン全体を破棄
   */
  destroy() {
    this.destroyAllElements();
    console.log('🗑️ Timeline破棄完了');
  }
}

window.Timeline = Timeline;