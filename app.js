class FlowgazerApp {
    constructor() {
        this.currentTab = 'global';
        this.isAutoUpdate = true;
        this.filterAuthors = null;
        this.flowgazerOnly = false;
        this.forbiddenWords = [];
        this.tabDataFetched = {
            global: false,
            following: false,
            myposts: false,
            likes: false
        };
    }

    async init() {
        console.log('🚀 flowgazer起動中...');
        this.updateLoginUI();

        const savedRelay = localStorage.getItem('relayUrl');
        const defaultRelay = 'wss://r.kojira.io/';
        const relay = savedRelay || defaultRelay;

        await this.connectRelay(relay);
        await this.fetchForbiddenWords();

        if (window.nostrAuth.isLoggedIn()) {
            this.fetchInitialData();
        }

        console.log('✅ flowgazer起動完了');
    }

    async connectRelay(url) {
        try {
            document.getElementById('relay-url').value = url;
            await window.relayManager.connect(url);
            this.subscribeMainTimeline();
            localStorage.setItem('relayUrl', url);
        } catch (err) {
            console.error('❌ リレー接続失敗:', err);
            alert('リレーに接続できませんでした: ' + url);
        }
    }

    subscribeMainTimeline() {
        const filters = [];
        const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;

        // ★ Global フィルタ: 自分を除外
        const globalFilter = {
            kinds: [1, 6],
            limit: 150
        };

        // 著者フィルタが設定されている場合
        if (this.filterAuthors && this.filterAuthors.length > 0) {
            globalFilter.authors = this.filterAuthors;
        }

        // ★ 自分のpubkeyを除外（NIP-01の'#p'タグ方式ではなく、クライアント側でフィルタ）
        // Relayによっては authors に ! プレフィックスをサポートしていない場合があるため、
        // 取得後にクライアント側でフィルタリングする方が確実
        filters.push(globalFilter);

        // Following フィルタ
        if (window.dataStore.followingPubkeys.size > 0) {
            const followingAuthors = Array.from(window.dataStore.followingPubkeys);
            // ★ 自分がフォローリストに含まれていても除外
            const filteredFollowing = myPubkey 
                ? followingAuthors.filter(pk => pk !== myPubkey)
                : followingAuthors;

            if (filteredFollowing.length > 0) {
                filters.push({
                    kinds: [1, 6],
                    authors: filteredFollowing,
                    limit: 150
                });
            }
        }

        // Likes フィルタ
        if (myPubkey) {
            filters.push({
                kinds: [7],
                '#p': [myPubkey],
                limit: 50
            });

            // 自分の投稿へのリアクション
            if (window.dataStore.myPostIds.size > 0) {
                filters.push({
                    kinds: [6, 7],
                    '#e': Array.from(window.dataStore.myPostIds)
                });
            }
        }

        if (filters.length > 0) {
            window.relayManager.unsubscribe('main-timeline');
            window.relayManager.subscribe('main-timeline', filters, (type, event) => {
                this.handleTimelineEvent(type, event);
            });
        }
    }

    handleTimelineEvent(type, event) {
        if (type === 'EVENT') {
            if (event.kind === 0) {
                try {
                    const profile = JSON.parse(event.content);
                    const updated = window.dataStore.addProfile(event.pubkey, {
                        ...profile,
                        created_at: event.created_at
                    });
                    if (updated) {
                        window.viewState.onProfileFetched(event.pubkey);
                    }
                } catch (err) {
                    console.error('プロファイルパースエラー:', err);
                }
                return;
            }

            // ★ クライアント側で自分の投稿を除外（kind:1のみ、kind:6は通す）
            const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;
            if (myPubkey && event.kind === 1 && event.pubkey === myPubkey) {
                // 自分の投稿は addEvent せず、DataStore 経由で selfFeed に追加される
                if (window.dataStore.addEvent(event)) {
                    window.profileFetcher.request(event.pubkey);
                }
                // ViewState には追加しない（global/following から除外）
                return;
            }

            if (window.dataStore.addEvent(event)) {
                window.viewState.addEvent(event);
                window.profileFetcher.request(event.pubkey);
            }
        } else if (type === 'EOSE') {
            console.log('📡 EOSE受信');
            window.profileFetcher.flushNow();
        }
    }

    fetchInitialData() {
        const myPubkey = window.nostrAuth.pubkey;

        // フォローリストの取得
        window.relayManager.subscribe('following-list', {
            kinds: [3],
            authors: [myPubkey],
            limit: 1
        }, (type, event) => {
            if (type === 'EVENT') {
                const pubkeys = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
                window.dataStore.setFollowingList(pubkeys);
                window.profileFetcher.requestMultiple(pubkeys);
            }
        });

        // 自分のふぁぼの取得
        window.relayManager.subscribe('my-likes', {
            kinds: [7],
            authors: [myPubkey]
        }, (type, event) => {
            if (type === 'EVENT') {
                window.dataStore.addEvent(event);
                window.viewState.addEvent(event);
            }
        });

        // ★ 初回のみ自分の投稿を取得（selfFeed用）
        this.fetchMyPostsForSelfFeed();
    }

    /**
     * ★ 新規: 自分の投稿を selfFeed に格納（初回のみ）
     */
    fetchMyPostsForSelfFeed() {
        const myPubkey = window.nostrAuth.pubkey;
        console.log('📥 自分の投稿を selfFeed 用に取得中...');

        window.relayManager.subscribe('self-feed-init', {
            kinds: [1],
            authors: [myPubkey],
            limit: 50
        }, (type, event) => {
            if (type === 'EVENT') {
                // DataStore に追加（selfFeed にも自動追加される）
                window.dataStore.addEvent(event);
            } else if (type === 'EOSE') {
                window.relayManager.unsubscribe('self-feed-init');
                console.log(`✅ selfFeed 初期化完了: ${window.dataStore.selfFeed.length}件`);
                // Global タブを再描画
                if (this.currentTab === 'global' || this.currentTab === 'following') {
                    window.viewState.renderNow();
                }
            }
        });
    }

    fetchMyPostsHistory() {
        const myPubkey = window.nostrAuth.pubkey;
        console.log('📥 自分の投稿履歴を取得中...');

        window.relayManager.subscribe('my-posts-history', {
            kinds: [1],
            authors: [myPubkey],
            limit: 100
        }, (type, event) => {
            if (type === 'EVENT') {
                if (window.dataStore.addEvent(event)) {
                    window.viewState.addHistoryEventToTab(event, 'myposts');
                    window.profileFetcher.request(event.pubkey);
                }
            } else if (type === 'EOSE') {
                console.log('✅ 自分の投稿履歴取得完了');
                window.viewState.renderNow();
            }
        });
    }

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
                    window.viewState.addHistoryEventToTab(event, 'likes');
                    window.profileFetcher.request(event.pubkey);
                }
            } else if (type === 'EOSE') {
                console.log('✅ 受け取ったふぁぼ取得完了');
                window.viewState.renderNow();
            }
        });
    }

    switchTab(tab) {
        this.currentTab = tab;
        console.log('🔀 タブ切り替え:', tab);

        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.toggle('active', btn.id === `tab-${tab}`);
        });

        window.viewState.switchTab(tab);

        if (!this.tabDataFetched[tab] && window.nostrAuth.isLoggedIn()) {
            if (tab === 'myposts') {
                this.fetchMyPostsHistory();
                this.tabDataFetched.myposts = true;
            } else if (tab === 'likes') {
                this.fetchReceivedLikes();
                this.tabDataFetched.likes = true;
            }
        }

        window.timeline.switchTab(tab);
    }

    applyFilter(authors) {
        this.filterAuthors = authors;
        window.timeline.setFilter({
            authors
        });
        window.relayManager.unsubscribe('main-timeline');
        this.subscribeMainTimeline();
    }

    toggleFlowgazerFilter(enabled) {
        this.flowgazerOnly = enabled;
        window.timeline.setFilter({
            flowgazerOnly: enabled
        });
    }

    loadMore() {
        const tab = this.currentTab;
        const oldestTimestamp = window.viewState.getOldestTimestamp(tab);
        console.log(`📥 もっと見る: ${tab}タブ, until=${new Date(oldestTimestamp * 1000).toLocaleString()}`);

        const filter = this._buildLoadMoreFilter(tab, oldestTimestamp);
        if (!filter) {
            console.warn('フィルタ構築に失敗しました');
            return;
        }

        document.getElementById('load-more').classList.add('loading');

        window.relayManager.subscribe('load-more', filter, (type, event) => {
            if (type === 'EVENT') {
                if (window.dataStore.addEvent(event)) {
                    window.viewState.addHistoryEventToTab(event, tab);
                    window.profileFetcher.request(event.pubkey);
                }
            } else if (type === 'EOSE') {
                window.relayManager.unsubscribe('load-more');
                document.getElementById('load-more').classList.remove('loading');
                console.log(`✅ もっと見る完了 (${tab})`);
                window.viewState.renderNow();
            }
        });
    }

    _buildLoadMoreFilter(tab, untilTimestamp) {
        const myPubkey = window.nostrAuth.isLoggedIn() ? window.nostrAuth.pubkey : null;
        
        const filter = {
            until: untilTimestamp - 1,
            limit: 50
        };

        switch (tab) {
            case 'global':
                filter.kinds = [1, 6];
                if (this.filterAuthors && this.filterAuthors.length > 0) {
                    filter.authors = this.filterAuthors;
                }
                // ★ 自分を除外する処理はクライアント側で行う
                // （Relay側で除外するには対応が必要だが、取得後フィルタで十分）
                break;
            case 'following':
                if (window.dataStore.followingPubkeys.size === 0) {
                    console.warn('フォローリストが空です');
                    return null;
                }
                filter.kinds = [1, 6];
                // ★ 自分を除外
                const followingAuthors = Array.from(window.dataStore.followingPubkeys);
                filter.authors = myPubkey 
                    ? followingAuthors.filter(pk => pk !== myPubkey)
                    : followingAuthors;
                break;
            case 'myposts':
                if (!window.nostrAuth.isLoggedIn()) {
                    console.warn('ログインが必要です');
                    return null;
                }
                filter.kinds = [1];
                filter.authors = [myPubkey];
                break;
            case 'likes':
                if (!window.nostrAuth.isLoggedIn()) {
                    console.warn('ログインが必要です');
                    return null;
                }
                filter.kinds = [7];
                filter['#p'] = [myPubkey];
                break;
            default:
                console.error('Unknown tab:', tab);
                return null;
        }
        return filter;
    }

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
            
            // ★ DataStoreに追加（selfFeedにも自動追加される）
            window.dataStore.addEvent(signed);
            
            // ★ ViewStateには myposts のみ追加
            window.viewState.addHistoryEventToTab(signed, 'myposts');
            
            // ★ 即座に再描画（global/followingで合成表示される）
            window.viewState.renderNow();
            
            alert('投稿しました!');
            document.getElementById('new-post-content').value = '';
        } catch (err) {
            console.error('投稿失敗:', err);
            alert('投稿に失敗しました: ' + err.message);
        }
    }

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
            window.dataStore.addEvent(signed);
            window.viewState.addEvent(signed);
            window.viewState.renderNow();
            alert('ふぁぼった!');
        } catch (err) {
            console.error('失敗:', err);
            alert('ふぁぼれませんでした: ' + err.message);
        }
    }

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

window.app = new FlowgazerApp();
console.log('✅ flowgazerApp初期化完了');
window.sendLikeEvent = (eventId, pubkey) => window.app.sendLike(eventId, pubkey);