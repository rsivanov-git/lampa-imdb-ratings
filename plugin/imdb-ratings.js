(function () {
    'use strict';

    var PLUGIN_FLAG = 'lampa_imdb_batch_rating';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    var VERSION = '6.2.0';
    var COMPONENT = 'imdb_batch_rating';
    var IMDB_ICON = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>IMDb</title><path fill="currentColor" d="M22.3781 0H1.6218C.7411.0583.0587.7437.0018 1.5953l-.001 20.783c.0585.8761.7125 1.543 1.5559 1.6191A.337.337 0 0 0 1.6016 24h20.7971a.4579.4579 0 0 0 .0437-.002c.8727-.0768 1.5568-.8271 1.5568-1.7085V1.7098c0-.8914-.696-1.6416-1.584-1.7078A.3294.3294 0 0 0 22.3781 0zm0 .496a1.2144 1.2144 0 0 1 1.1252 1.2139v20.5797c0 .6377-.4875 1.1602-1.1045 1.2145H1.6016c-.5967-.0543-1.0645-.5297-1.1053-1.1258V1.6284C.5371 1.0185 1.0184.5364 1.6217.496h20.7564zM4.7954 8.2603v7.3636H2.8899V8.2603h1.9055zm6.5367 0v7.3636H9.6707v-4.9704l-.6711 4.9704H7.813l-.6986-4.8618-.0066 4.8618h-1.668V8.2603h2.468c.0748.4476.1492.9694.2307 1.5734l.2712 1.8713.4407-3.4447h2.4817zm2.9772 1.3289c.0742.0404.122.108.1417.2034.0279.0953.0345.3118.0345.6442v2.8548c0 .4881-.0345.7867-.0955.8954-.0609.1152-.2304.1695-.5018.1695V9.5211c.204 0 .3457.0205.4211.0681zm-.0211 6.0347c.4543 0 .8006-.0265 1.0245-.0742.2304-.0477.4204-.1357.5694-.2648.1556-.1218.2642-.298.3251-.5219.0611-.2238.1021-.6648.1021-1.3224v-2.5832c0-.6986-.0271-1.1668-.0742-1.4039-.041-.237-.1431-.4543-.3126-.6437-.1695-.1973-.4198-.3324-.7456-.421-.3191-.0808-.8542-.1285-1.7694-.1285h-1.4244v7.3636h2.3051zm5.14-1.7827c0 .3523-.0199.5762-.0544.6708-.033.0947-.1894.1424-.3046.1424-.1086 0-.19-.0477-.2238-.1351-.041-.0887-.0609-.2986-.0609-.6238v-1.9469c0-.3324.0199-.5423.0543-.6237.0338-.0808.1086-.122.2171-.122.1153 0 .2709.0412.3114.1425.041.0947.0609.2986.0609.6032v1.8926zm-2.4747-5.5809v7.3636h1.7157l.1152-.4675c.1556.1894.3251.3324.5152.4271.1828.0881.4608.1357.678.1357.3047 0 .5629-.0748.7802-.237.2165-.1562.3589-.3462.4198-.5628.0543-.2173.0887-.543.0887-.9841v-2.0675c0-.4409-.0139-.7324-.0344-.8681-.0199-.1357-.0742-.2781-.1695-.4204-.1021-.1425-.2437-.251-.4272-.3325-.1834-.0742-.3999-.1152-.6576-.1152-.2172 0-.4952.0477-.6846.1285-.1835.0887-.353.2238-.5086.4007V8.2603h-1.8309z"/></svg>';

    var SETTINGS = {
        url: 'imdb_batch_url',
        token: 'imdb_batch_token',
        label: 'imdb_batch_label'
    };

    var ATTR = {
        loading: 'data-imdb-rating-loading',
        loaded: 'data-imdb-rating-loaded',
        rating: 'data-imdb-rating',
        createdVote: 'data-imdb-created-vote',
        originalText: 'data-imdb-original-text',
        originalTitle: 'data-imdb-original-title',
        originalHadTitle: 'data-imdb-original-had-title',
        originalHidden: 'data-imdb-original-hidden',
        detailLoading: 'data-imdb-detail-loading',
        detailLoaded: 'data-imdb-detail-loaded',
        detailCreated: 'data-imdb-detail-created',
        detailOriginalHidden: 'data-imdb-detail-original-hidden',
        detailOriginalText: 'data-imdb-detail-original-text',
        detailOriginalTitle: 'data-imdb-detail-original-title',
        detailOriginalHadTitle: 'data-imdb-detail-original-had-title',
        torrentLoading: 'data-imdb-torrent-loading',
        torrentLoaded: 'data-imdb-torrent-loaded',
        torrentOriginalHidden: 'data-imdb-torrent-original-hidden',
        torrentOriginalText: 'data-imdb-torrent-original-text',
        torrentOriginalTitle: 'data-imdb-torrent-original-title',
        torrentOriginalHadTitle: 'data-imdb-torrent-original-had-title'
    };

    var BATCH_DELAY_MS = 100;
    var MAX_BATCH_SIZE = 60;
    var START_RETRY_MS = 250;
    var REQUEST_RETRY_MS = 500;
    var MAX_REQUEST_ATTEMPTS = 3;

    var state = {
        cache: new Map(),
        queue: new Map(),
        flushTimer: null,
        generation: 0,
        started: false,
        componentRegistered: false,
        registeredSettings: {},
        fullListenerRegistered: false,
        activityListenerRegistered: false,
        observer: null,
        cardPatched: false
    };

    function getSetting(key, defaultValue) {
        var value = Lampa.Storage.get(key, defaultValue);
        return value === undefined || value === null ? defaultValue : value;
    }

    function getServiceUrl() {
        return String(getSetting(SETTINGS.url, '') || '').trim().replace(/\/+$/, '');
    }

    function getServiceToken() {
        return String(getSetting(SETTINGS.token, '') || '').trim();
    }

    function shouldShowLabel() {
        return !!getSetting(SETTINGS.label, false);
    }

    function normalizeTmdbId(value) {
        var id = Number(value);
        return isFinite(id) && id > 0 && Math.floor(id) === id ? id : 0;
    }

    function normalizeImdbId(value) {
        value = String(value || '');
        return /^tt\d+$/.test(value) ? value : null;
    }

    function getMediaType(data) {
        if (!data) return 'movie';

        var explicit = String(data.media_type || data.type || data.method || '').toLowerCase();
        if (explicit === 'tv' || explicit === 'series' || explicit === 'serial') return 'tv';
        if (explicit === 'movie') return 'movie';

        if (data.first_air_date) return 'tv';
        if (data.original_name) return 'tv';
        if (data.number_of_seasons != null || data.number_of_episodes != null) return 'tv';

        return 'movie';
    }

    function createRequest(data) {
        if (!data) return null;

        var type = getMediaType(data);
        var tmdb = normalizeTmdbId(data.id);
        var imdb = normalizeImdbId(data.imdb_id || data.imdbId);
        if (!tmdb && !imdb) return null;

        return {
            key: tmdb ? type + ':' + tmdb : 'imdb:' + imdb,
            item: {
                type: type,
                tmdb: tmdb || null,
                imdb: imdb || null
            }
        };
    }

    function formatRating(value) {
        var rating = Number(value).toFixed(1);
        return shouldShowLabel() ? 'IMDb ' + rating : rating;
    }

    function formatTooltip(result) {
        var text = 'IMDb: ' + Number(result.rating).toFixed(1);
        if (result.votes != null) text += ' · ' + result.votes + ' votes';
        return text;
    }

    function findOrCreateVote(card) {
        var vote = card.querySelector('.card__vote');
        if (vote) return vote;

        var view = card.querySelector('.card__view');
        if (!view) return null;

        vote = document.createElement('div');
        vote.classList.add('card__vote');
        vote.setAttribute(ATTR.createdVote, '1');
        view.appendChild(vote);
        return vote;
    }

    function rememberVote(vote) {
        if (!vote || vote.getAttribute(ATTR.createdVote) === '1' || vote.hasAttribute(ATTR.originalText)) return;

        vote.setAttribute(ATTR.originalText, vote.innerText || '');
        vote.setAttribute(ATTR.originalHidden, vote.classList.contains('hide') ? '1' : '0');
        if (vote.hasAttribute('title')) {
            vote.setAttribute(ATTR.originalHadTitle, '1');
            vote.setAttribute(ATTR.originalTitle, vote.getAttribute('title') || '');
        }
    }

    function applyCardResult(card, result) {
        if (!card) return;
        card.removeAttribute(ATTR.loading);

        if (!document.documentElement.contains(card)) return;

        if (!result || result.rating == null) {
            var existingVote = card.querySelector('.card__vote');
            if (existingVote) {
                rememberVote(existingVote);
                existingVote.classList.add('hide');
                existingVote.removeAttribute('title');
                existingVote.removeAttribute(ATTR.rating);
            }
            card.setAttribute(ATTR.loaded, '1');
            return;
        }

        var vote = findOrCreateVote(card);
        if (!vote) return;

        rememberVote(vote);
        vote.classList.remove('hide');
        vote.innerText = formatRating(result.rating);
        vote.title = formatTooltip(result);
        vote.setAttribute(ATTR.rating, result.rating);
        card.setAttribute(ATTR.loaded, '1');
    }

    function restoreCard(card) {
        if (!card) return;
        var vote = card.querySelector('.card__vote');
        if (!vote) return;

        if (vote.getAttribute(ATTR.createdVote) === '1') {
            if (vote.parentNode) vote.parentNode.removeChild(vote);
        } else if (vote.hasAttribute(ATTR.originalText) || vote.hasAttribute(ATTR.originalHidden)) {
            if (vote.hasAttribute(ATTR.originalText)) vote.innerText = vote.getAttribute(ATTR.originalText) || '';
            if (vote.getAttribute(ATTR.originalHadTitle) === '1') vote.setAttribute('title', vote.getAttribute(ATTR.originalTitle) || '');
            else vote.removeAttribute('title');

            if (vote.getAttribute(ATTR.originalHidden) === '1') vote.classList.add('hide');
            else vote.classList.remove('hide');

            vote.removeAttribute(ATTR.rating);
            vote.removeAttribute(ATTR.originalText);
            vote.removeAttribute(ATTR.originalTitle);
            vote.removeAttribute(ATTR.originalHadTitle);
            vote.removeAttribute(ATTR.originalHidden);
        }

        card.removeAttribute(ATTR.loading);
        card.removeAttribute(ATTR.loaded);
    }

    function rememberHidden(element) {
        if (!element || element.hasAttribute(ATTR.detailOriginalHidden)) return;
        element.setAttribute(ATTR.detailOriginalHidden, element.classList.contains('hide') ? '1' : '0');
    }

    function restoreHidden(element) {
        if (!element || !element.hasAttribute(ATTR.detailOriginalHidden)) return;
        if (element.getAttribute(ATTR.detailOriginalHidden) === '1') element.classList.add('hide');
        else element.classList.remove('hide');
        element.removeAttribute(ATTR.detailOriginalHidden);
    }

    function findOrCreateDetailImdb(root) {
        var imdb = root.querySelector('.rate--imdb');
        if (imdb) return imdb;

        var line = root.querySelector('.full-start-new__rate-line');
        if (!line) return null;

        imdb = document.createElement('div');
        imdb.classList.add('full-start__rate');
        imdb.classList.add('rate--imdb');
        imdb.setAttribute(ATTR.detailCreated, '1');

        var value = document.createElement('div');
        var source = document.createElement('div');
        source.innerText = 'IMDB';
        imdb.appendChild(value);
        imdb.appendChild(source);
        line.appendChild(imdb);
        return imdb;
    }

    function rememberDetailImdb(imdb) {
        if (!imdb || imdb.getAttribute(ATTR.detailCreated) === '1' || imdb.hasAttribute(ATTR.detailOriginalText)) return;

        rememberHidden(imdb);
        var value = imdb.children[0];
        imdb.setAttribute(ATTR.detailOriginalText, value ? value.innerText || '' : '');
        if (imdb.hasAttribute('title')) {
            imdb.setAttribute(ATTR.detailOriginalHadTitle, '1');
            imdb.setAttribute(ATTR.detailOriginalTitle, imdb.getAttribute('title') || '');
        }
    }

    function applyDetailResult(root, result) {
        if (!root) return;
        root.removeAttribute(ATTR.detailLoading);

        if (!document.documentElement.contains(root)) return;

        var tmdb = root.querySelector('.rate--tmdb');
        var existingImdb = root.querySelector('.rate--imdb');
        rememberHidden(tmdb);
        rememberDetailImdb(existingImdb);
        if (tmdb) tmdb.classList.add('hide');

        if (!result || result.rating == null) {
            if (existingImdb) existingImdb.classList.add('hide');
            root.setAttribute(ATTR.detailLoaded, '1');
            return;
        }

        var imdb = findOrCreateDetailImdb(root);
        if (!imdb || !imdb.children[0]) return;

        rememberDetailImdb(imdb);
        imdb.classList.remove('hide');
        imdb.children[0].innerText = Number(result.rating).toFixed(1);
        imdb.title = formatTooltip(result);
        root.setAttribute(ATTR.detailLoaded, '1');
    }

    function restoreDetail(root) {
        if (!root) return;

        var tmdb = root.querySelector('.rate--tmdb');
        var imdb = root.querySelector('.rate--imdb');
        restoreHidden(tmdb);

        if (imdb && imdb.getAttribute(ATTR.detailCreated) === '1') {
            if (imdb.parentNode) imdb.parentNode.removeChild(imdb);
        } else if (imdb) {
            if (imdb.hasAttribute(ATTR.detailOriginalText) && imdb.children[0]) imdb.children[0].innerText = imdb.getAttribute(ATTR.detailOriginalText) || '';
            if (imdb.getAttribute(ATTR.detailOriginalHadTitle) === '1') imdb.setAttribute('title', imdb.getAttribute(ATTR.detailOriginalTitle) || '');
            else imdb.removeAttribute('title');
            restoreHidden(imdb);
            imdb.removeAttribute(ATTR.detailOriginalText);
            imdb.removeAttribute(ATTR.detailOriginalTitle);
            imdb.removeAttribute(ATTR.detailOriginalHadTitle);
        }

        root.removeAttribute(ATTR.detailLoading);
        root.removeAttribute(ATTR.detailLoaded);
    }

    function rememberTorrentRate(rate, value) {
        if (!rate || rate.hasAttribute(ATTR.torrentOriginalHidden)) return;
        rate.setAttribute(ATTR.torrentOriginalHidden, rate.classList.contains('hide') ? '1' : '0');
        rate.setAttribute(ATTR.torrentOriginalText, value ? value.innerText || '' : '');
        if (rate.hasAttribute('title')) {
            rate.setAttribute(ATTR.torrentOriginalHadTitle, '1');
            rate.setAttribute(ATTR.torrentOriginalTitle, rate.getAttribute('title') || '');
        }
    }

    function applyTorrentResult(root, result) {
        if (!root) return;
        root.removeAttribute(ATTR.torrentLoading);

        if (!document.documentElement.contains(root)) return;

        var rate = root.querySelector('.explorer-card__head-rate');
        var value = rate && rate.querySelector('span');
        if (!rate || !value) return;

        rememberTorrentRate(rate, value);

        if (!result || result.rating == null) {
            rate.classList.add('hide');
            rate.removeAttribute('title');
            root.setAttribute(ATTR.torrentLoaded, '1');
            return;
        }

        rate.classList.remove('hide');
        value.innerText = formatRating(result.rating);
        rate.title = formatTooltip(result);
        root.setAttribute(ATTR.torrentLoaded, '1');
    }

    function restoreTorrent(root) {
        if (!root) return;
        var rate = root.querySelector('.explorer-card__head-rate');
        var value = rate && rate.querySelector('span');

        if (rate && rate.hasAttribute(ATTR.torrentOriginalHidden)) {
            if (value) value.innerText = rate.getAttribute(ATTR.torrentOriginalText) || '';
            if (rate.getAttribute(ATTR.torrentOriginalHadTitle) === '1') rate.setAttribute('title', rate.getAttribute(ATTR.torrentOriginalTitle) || '');
            else rate.removeAttribute('title');

            if (rate.getAttribute(ATTR.torrentOriginalHidden) === '1') rate.classList.add('hide');
            else rate.classList.remove('hide');

            rate.removeAttribute(ATTR.torrentOriginalHidden);
            rate.removeAttribute(ATTR.torrentOriginalText);
            rate.removeAttribute(ATTR.torrentOriginalTitle);
            rate.removeAttribute(ATTR.torrentOriginalHadTitle);
        }

        root.removeAttribute(ATTR.torrentLoading);
        root.removeAttribute(ATTR.torrentLoaded);
    }

    function scheduleFlush() {
        clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }

    function getQueueEntry(request) {
        var entry = state.queue.get(request.key);
        if (!entry) {
            entry = { item: request.item, cards: [], details: [], torrents: [] };
            state.queue.set(request.key, entry);
        }
        return entry;
    }

    function enqueueCard(card, data) {
        if (!getServiceUrl() || !card || !data) return;
        if (data.media_type === 'person' || data.profile_path) return;

        var request = createRequest(data);
        if (!request) return;

        if (state.cache.has(request.key)) {
            applyCardResult(card, state.cache.get(request.key));
            return;
        }
        if (card.getAttribute(ATTR.loading) === '1') return;

        card.setAttribute(ATTR.loading, '1');
        getQueueEntry(request).cards.push(card);
        scheduleFlush();
    }

    function enqueueDetail(root, data) {
        if (!getServiceUrl() || !root || !data) return;

        var request = createRequest(data);
        if (!request) return;

        if (state.cache.has(request.key)) {
            applyDetailResult(root, state.cache.get(request.key));
            return;
        }
        if (root.getAttribute(ATTR.detailLoading) === '1') return;

        root.setAttribute(ATTR.detailLoading, '1');
        getQueueEntry(request).details.push(root);
        scheduleFlush();
    }

    function enqueueTorrent(root, data) {
        if (!getServiceUrl() || !root || !data) return;

        var request = createRequest(data);
        if (!request) return;

        if (state.cache.has(request.key)) {
            applyTorrentResult(root, state.cache.get(request.key));
            return;
        }
        if (root.getAttribute(ATTR.torrentLoading) === '1') return;

        root.setAttribute(ATTR.torrentLoading, '1');
        getQueueEntry(request).torrents.push(root);
        scheduleFlush();
    }

    function takeBatch() {
        var entries = Array.from(state.queue.entries()).slice(0, MAX_BATCH_SIZE);
        entries.forEach(function (entry) { state.queue.delete(entry[0]); });
        return entries;
    }

    function createHeaders() {
        var headers = { 'Content-Type': 'application/json' };
        var token = getServiceToken();
        if (token) headers['X-Api-Key'] = token;
        return headers;
    }

    async function requestRatings(entries) {
        var response = await fetch(getServiceUrl() + '/api/ratings', {
            method: 'POST',
            headers: createHeaders(),
            body: JSON.stringify({
                items: entries.map(function (entry) { return entry[1].item; })
            })
        });

        if (!response.ok) {
            var error = new Error('Rating service returned HTTP ' + response.status);
            error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            throw error;
        }

        var payload = await response.json();
        return payload.items || {};
    }

    function applyBatch(entries, results) {
        entries.forEach(function (entry) {
            var key = entry[0];
            var queued = entry[1];
            var result = results[key] || { rating: null, votes: null };

            state.cache.set(key, result);
            queued.cards.forEach(function (card) { applyCardResult(card, result); });
            queued.details.forEach(function (root) { applyDetailResult(root, result); });
            queued.torrents.forEach(function (root) { applyTorrentResult(root, result); });
        });
    }

    function releaseBatch(entries) {
        entries.forEach(function (entry) {
            var unavailable = { rating: null, votes: null };
            entry[1].cards.forEach(function (card) { applyCardResult(card, unavailable); });
            entry[1].details.forEach(function (root) { applyDetailResult(root, unavailable); });
            entry[1].torrents.forEach(function (root) { applyTorrentResult(root, unavailable); });
        });
    }

    async function processBatch(entries, generation, attempt) {
        try {
            var results = await requestRatings(entries);
            if (generation === state.generation) applyBatch(entries, results);
        } catch (error) {
            if (generation !== state.generation) return;

            if (error.retryable !== false && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                setTimeout(function () {
                    if (generation === state.generation) processBatch(entries, generation, attempt + 1);
                }, REQUEST_RETRY_MS * Math.pow(2, attempt));
                return;
            }

            console.log('[IMDb Ratings] request failed:', error.message || String(error));
            releaseBatch(entries);
        }
    }

    function flushQueue() {
        state.flushTimer = null;
        if (!state.queue.size) return;

        var entries = takeBatch();
        processBatch(entries, state.generation, 0);
        if (state.queue.size) scheduleFlush();
    }

    function getCardElement(instance) {
        if (!instance) return null;
        if (instance.render) {
            var rendered = instance.render(true);
            if (rendered && rendered.nodeType === 1) return rendered;
        }
        return instance.html && instance.html.nodeType === 1 ? instance.html : null;
    }

    function patchCardCreate() {
        if (state.cardPatched || !Lampa.Card || !Lampa.Card.prototype) return;

        var proto = Lampa.Card.prototype;
        var originalCreate = proto.create;
        if (typeof originalCreate !== 'function') return;
        if (originalCreate.__imdbRatingsPatched) {
            state.cardPatched = true;
            return;
        }

        function patchedCreate() {
            var result = originalCreate.apply(this, arguments);
            try {
                var card = getCardElement(this);
                if (card && this.data) {
                    card.card_data = this.data;
                    enqueueCard(card, this.data);
                }
            } catch (error) {
                console.log('[IMDb Ratings] card hook error:', error.message || String(error));
            }
            return result;
        }

        patchedCreate.__imdbRatingsPatched = true;
        patchedCreate.__imdbRatingsOriginal = originalCreate;
        proto.create = patchedCreate;
        state.cardPatched = true;
        console.log('[IMDb Ratings] Lampa.Card hook installed');
    }

    function scanExistingCards(root) {
        if (!getServiceUrl()) return;
        root = root || document;

        if (root.nodeType === 1 && root.classList && root.classList.contains('card') && root.card_data) {
            enqueueCard(root, root.card_data);
        }
        if (!root.querySelectorAll) return;

        var cards = root.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].card_data) enqueueCard(cards[i], cards[i].card_data);
        }
    }

    function observeFallback() {
        if (state.observer) return;

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                for (var i = 0; i < mutation.addedNodes.length; i++) {
                    var node = mutation.addedNodes[i];
                    if (node && node.nodeType === 1) scanExistingCards(node);
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
        state.observer = observer;
    }

    function unwrapElement(value) {
        if (!value) return null;
        if (value.nodeType === 1) return value;
        if (value[0] && value[0].nodeType === 1) return value[0];
        return null;
    }

    function findFullStart(event) {
        if (event && event.item && event.name === 'start' && event.item.render) {
            var direct = event.item.render(true);
            if (direct && direct.nodeType === 1) return direct;
        }

        var body = unwrapElement(event && event.body);
        if (body) {
            if (body.classList && body.classList.contains('full-start-new')) return body;
            if (body.querySelector) {
                var nested = body.querySelector('.full-start-new');
                if (nested) return nested;
            }
        }
        return null;
    }

    function getFullMovie(event) {
        if (event && event.data && event.data.movie) return event.data.movie;
        if (event && event.item && event.item.card) return event.item.card;
        if (event && event.object && event.object.card) return event.object.card;

        if (Lampa.Activity && Lampa.Activity.active) {
            var active = Lampa.Activity.active();
            if (active && active.card) return active.card;
            if (active && active.movie) return active.movie;
        }
        return null;
    }

    function processFullEvent(event) {
        if (!event) return;
        if (!(event.type === 'build' && event.name === 'start') && event.type !== 'complite') return;

        var root = findFullStart(event);
        var movie = getFullMovie(event);
        if (!root || !movie) return;

        root.imdb_detail_data = movie;
        enqueueDetail(root, movie);
    }

    function registerFullListener() {
        if (state.fullListenerRegistered || !Lampa.Listener) return;
        Lampa.Listener.follow('full', processFullEvent);
        state.fullListenerRegistered = true;
    }

    function findTorrentRoot(object) {
        if (!object || !object.activity || !object.activity.render) return null;
        var rendered = object.activity.render();
        var body = rendered && rendered[0] ? rendered[0] : rendered;
        if (!body) return null;
        if (body.classList && body.classList.contains('explorer')) return body;
        return body.querySelector ? body.querySelector('.explorer') : null;
    }

    function processTorrentActivity(object) {
        if (!object || object.component !== 'torrents' || !object.movie) return;
        var root = findTorrentRoot(object);
        if (root) enqueueTorrent(root, object.movie);
    }

    function registerActivityListener() {
        if (state.activityListenerRegistered || !Lampa.Listener) return;
        Lampa.Listener.follow('activity', function (event) {
            if (event && event.type === 'start') processTorrentActivity(event.object);
        });
        state.activityListenerRegistered = true;
    }

    function addSetting(key, type, defaultValue, name, description) {
        if (state.registeredSettings[key]) return;

        var param = { name: key, type: type, default: defaultValue };
        if (type === 'input') param.values = '';

        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: param,
            field: { name: name, description: description },
            onChange: resetPlugin
        });
        state.registeredSettings[key] = true;
    }

    function registerSettings() {
        if (!Lampa.SettingsApi) return;

        if (!state.componentRegistered) {
            Lampa.SettingsApi.addComponent({
                component: COMPONENT,
                name: 'IMDb Ratings',
                icon: IMDB_ICON
            });
            state.componentRegistered = true;
        }

        addSetting(SETTINGS.url, 'input', '', 'Rating service URL', 'For example: https://ratings.example.com');
        addSetting(SETTINGS.token, 'input', '', 'Service token', 'Sent to the rating service as X-Api-Key');
        addSetting(SETTINGS.label, 'trigger', false, 'Show IMDb label', 'Display IMDb 8.4 instead of 8.4');
    }

    function resetPlugin() {
        state.generation++;
        state.cache.clear();
        state.queue.clear();
        clearTimeout(state.flushTimer);
        state.flushTimer = null;

        var cards = document.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) restoreCard(cards[i]);

        var details = document.querySelectorAll('.full-start-new');
        for (var j = 0; j < details.length; j++) restoreDetail(details[j]);

        var torrents = document.querySelectorAll('.explorer');
        for (var k = 0; k < torrents.length; k++) restoreTorrent(torrents[k]);

        setTimeout(function () {
            scanExistingCards(document);
            if (Lampa.Activity && Lampa.Activity.active) processTorrentActivity(Lampa.Activity.active());
        }, START_RETRY_MS);
    }

    function startPlugin() {
        if (state.started) return;
        if (!window.Lampa || !Lampa.Storage || !Lampa.SettingsApi || !Lampa.Listener || !Lampa.Card || !document.body) return;

        registerSettings();
        patchCardCreate();
        registerFullListener();
        registerActivityListener();
        observeFallback();
        scanExistingCards(document);

        state.started = true;
        console.log('[IMDb Ratings] v' + VERSION + ' started');
    }

    function tryStartPlugin() {
        if (state.started) return;
        try {
            startPlugin();
        } catch (error) {
            console.log('[IMDb Ratings] startup error:', error.message || String(error));
        }
        if (!state.started) setTimeout(tryStartPlugin, START_RETRY_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryStartPlugin);
    tryStartPlugin();
})();