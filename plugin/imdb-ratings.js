(function () {
    'use strict';

    var PLUGIN_FLAG = 'lampa_imdb_batch_rating';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    var COMPONENT = 'imdb_batch_rating';
    var IMDB_ICON = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>IMDb</title><path fill="currentColor" d="M22.3781 0H1.6218C.7411.0583.0587.7437.0018 1.5953l-.001 20.783c.0585.8761.7125 1.543 1.5559 1.6191A.337.337 0 0 0 1.6016 24h20.7971a.4579.4579 0 0 0 .0437-.002c.8727-.0768 1.5568-.8271 1.5568-1.7085V1.7098c0-.8914-.696-1.6416-1.584-1.7078A.3294.3294 0 0 0 22.3781 0zm0 .496a1.2144 1.2144 0 0 1 1.1252 1.2139v20.5797c0 .6377-.4875 1.1602-1.1045 1.2145H1.6016c-.5967-.0543-1.0645-.5297-1.1053-1.1258V1.6284C.5371 1.0185 1.0184.5364 1.6217.496h20.7564zM4.7954 8.2603v7.3636H2.8899V8.2603h1.9055zm6.5367 0v7.3636H9.6707v-4.9704l-.6711 4.9704H7.813l-.6986-4.8618-.0066 4.8618h-1.668V8.2603h2.468c.0748.4476.1492.9694.2307 1.5734l.2712 1.8713.4407-3.4447h2.4817zm2.9772 1.3289c.0742.0404.122.108.1417.2034.0279.0953.0345.3118.0345.6442v2.8548c0 .4881-.0345.7867-.0955.8954-.0609.1152-.2304.1695-.5018.1695V9.5211c.204 0 .3457.0205.4211.0681zm-.0211 6.0347c.4543 0 .8006-.0265 1.0245-.0742.2304-.0477.4204-.1357.5694-.2648.1556-.1218.2642-.298.3251-.5219.0611-.2238.1021-.6648.1021-1.3224v-2.5832c0-.6986-.0271-1.1668-.0742-1.4039-.041-.237-.1431-.4543-.3126-.6437-.1695-.1973-.4198-.3324-.7456-.421-.3191-.0808-.8542-.1285-1.7694-.1285h-1.4244v7.3636h2.3051zm5.14-1.7827c0 .3523-.0199.5762-.0544.6708-.033.0947-.1894.1424-.3046.1424-.1086 0-.19-.0477-.2238-.1351-.041-.0887-.0609-.2986-.0609-.6238v-1.9469c0-.3324.0199-.5423.0543-.6237.0338-.0808.1086-.122.2171-.122.1153 0 .2709.0412.3114.1425.041.0947.0609.2986.0609.6032v1.8926zm-2.4747-5.5809v7.3636h1.7157l.1152-.4675c.1556.1894.3251.3324.5152.4271.1828.0881.4608.1357.678.1357.3047 0 .5629-.0748.7802-.237.2165-.1562.3589-.3462.4198-.5628.0543-.2173.0887-.543.0887-.9841v-2.0675c0-.4409-.0139-.7324-.0344-.8681-.0199-.1357-.0742-.2781-.1695-.4204-.1021-.1425-.2437-.251-.4272-.3325-.1834-.0742-.3999-.1152-.6576-.1152-.2172 0-.4952.0477-.6846.1285-.1835.0887-.353.2238-.5086.4007V8.2603h-1.8309z"/></svg>';
    var SETTINGS = {
        url: 'imdb_batch_url',
        token: 'imdb_batch_token',
        enabled: 'imdb_batch_enabled',
        label: 'imdb_batch_label'
    };
    var ATTRIBUTES = {
        loading: 'data-imdb-rating-loading',
        loaded: 'data-imdb-rating-loaded',
        rating: 'data-imdb-rating',
        createdVote: 'data-imdb-created-vote',
        originalText: 'data-imdb-original-text',
        originalTitle: 'data-imdb-original-title',
        originalHadTitle: 'data-imdb-original-had-title',
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
    var CARD_SELECTOR = '.card';
    var BATCH_DELAY_MS = 120;
    var MAX_BATCH_SIZE = 60;
    var START_RETRY_MS = 250;
    var REQUEST_RETRY_MS = 500;
    var MAX_REQUEST_ATTEMPTS = 3;
    var CARD_DATA_RETRY_DELAYS = [50, 150, 400, 800];

    var state = {
        cache: new Map(),
        queue: new Map(),
        flushTimer: null,
        generation: 0,
        started: false,
        componentRegistered: false,
        registeredSettings: {},
        observer: null,
        fullListenerRegistered: false,
        activityListenerRegistered: false
    };

    function getSetting(key, defaultValue) {
        var value = Lampa.Storage.get(key, defaultValue);
        return value === undefined || value === null ? defaultValue : value;
    }

    function isEnabled() {
        return !!getSetting(SETTINGS.enabled, true);
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

    function getMediaType(data) {
        return data.media_type === 'tv' || data.first_air_date || (data.name && !data.title) ? 'tv' : 'movie';
    }

    function normalizeTmdbId(value) {
        var id = Number(value);
        return isFinite(id) && id > 0 && Math.floor(id) === id && id <= 9007199254740991 ? id : 0;
    }

    function normalizeImdbId(value) {
        value = String(value || '');
        return /^tt\d+$/.test(value) ? value : null;
    }

    function createRequest(data) {
        var type = getMediaType(data);
        var tmdb = normalizeTmdbId(data.id);
        var imdb = normalizeImdbId(data.imdb_id);
        if (!tmdb && !imdb) return null;

        return {
            key: tmdb ? type + ':' + tmdb : 'imdb:' + imdb,
            item: { type: type, tmdb: tmdb, imdb: imdb }
        };
    }

    function findOrCreateVote(card) {
        var vote = card.querySelector('.card__vote');
        if (vote) return vote;

        var view = card.querySelector('.card__view');
        if (!view) return null;

        vote = document.createElement('div');
        vote.classList.add('card__vote');
        vote.setAttribute(ATTRIBUTES.createdVote, '1');
        view.appendChild(vote);
        return vote;
    }

    function rememberVoteState(vote) {
        if (vote.getAttribute(ATTRIBUTES.createdVote) === '1' || vote.hasAttribute(ATTRIBUTES.originalText)) return;

        vote.setAttribute(ATTRIBUTES.originalText, vote.innerText || '');
        if (vote.hasAttribute('title')) {
            vote.setAttribute(ATTRIBUTES.originalHadTitle, '1');
            vote.setAttribute(ATTRIBUTES.originalTitle, vote.getAttribute('title') || '');
        }
    }

    function restoreVote(card) {
        var vote = card.querySelector('.card__vote');
        if (!vote || !vote.hasAttribute(ATTRIBUTES.rating)) return;

        if (vote.getAttribute(ATTRIBUTES.createdVote) === '1') {
            if (vote.parentNode) vote.parentNode.removeChild(vote);
            return;
        }

        if (vote.hasAttribute(ATTRIBUTES.originalText)) {
            vote.innerText = vote.getAttribute(ATTRIBUTES.originalText) || '';
        }
        if (vote.getAttribute(ATTRIBUTES.originalHadTitle) === '1') {
            vote.setAttribute('title', vote.getAttribute(ATTRIBUTES.originalTitle) || '');
        } else {
            vote.removeAttribute('title');
        }

        vote.removeAttribute(ATTRIBUTES.rating);
        vote.removeAttribute(ATTRIBUTES.originalText);
        vote.removeAttribute(ATTRIBUTES.originalTitle);
        vote.removeAttribute(ATTRIBUTES.originalHadTitle);
    }

    function rememberDetailState(element) {
        if (!element || element.hasAttribute(ATTRIBUTES.detailOriginalHidden)) return;

        element.setAttribute(ATTRIBUTES.detailOriginalHidden, element.classList.contains('hide') ? '1' : '0');
    }

    function restoreDetailElement(element) {
        if (!element || !element.hasAttribute(ATTRIBUTES.detailOriginalHidden)) return;

        if (element.getAttribute(ATTRIBUTES.detailOriginalHidden) === '1') element.classList.add('hide');
        else element.classList.remove('hide');
        element.removeAttribute(ATTRIBUTES.detailOriginalHidden);
    }

    function findOrCreateDetailImdb(root) {
        var imdb = root.querySelector('.rate--imdb');
        if (imdb) return imdb;

        var line = root.querySelector('.full-start-new__rate-line');
        if (!line) return null;

        imdb = document.createElement('div');
        imdb.classList.add('full-start__rate');
        imdb.classList.add('rate--imdb');
        imdb.setAttribute(ATTRIBUTES.detailCreated, '1');

        var value = document.createElement('div');
        var source = document.createElement('div');
        source.innerText = 'IMDB';
        imdb.appendChild(value);
        imdb.appendChild(source);
        line.appendChild(imdb);
        return imdb;
    }

    function rememberDetailImdb(imdb) {
        if (imdb.getAttribute(ATTRIBUTES.detailCreated) === '1' || imdb.hasAttribute(ATTRIBUTES.detailOriginalText)) return;

        rememberDetailState(imdb);
        var value = imdb.children[0];
        imdb.setAttribute(ATTRIBUTES.detailOriginalText, value ? value.innerText || '' : '');
        if (imdb.hasAttribute('title')) {
            imdb.setAttribute(ATTRIBUTES.detailOriginalHadTitle, '1');
            imdb.setAttribute(ATTRIBUTES.detailOriginalTitle, imdb.getAttribute('title') || '');
        }
    }

    function applyDetailResult(root, result) {
        if (!root) return;
        root.removeAttribute(ATTRIBUTES.detailLoading);

        if (!document.documentElement.contains(root)) return;
        if (!result || result.rating == null) {
            root.setAttribute(ATTRIBUTES.detailLoaded, '1');
            return;
        }

        var tmdb = root.querySelector('.rate--tmdb');
        var imdb = findOrCreateDetailImdb(root);
        if (!imdb || !imdb.children[0]) return;

        rememberDetailState(tmdb);
        rememberDetailImdb(imdb);
        if (tmdb) tmdb.classList.add('hide');
        imdb.classList.remove('hide');
        imdb.children[0].innerText = Number(result.rating).toFixed(1);
        imdb.title = formatTooltip(result);
        root.setAttribute(ATTRIBUTES.detailLoaded, '1');
    }

    function restoreDetail(root) {
        if (!root) return;

        var tmdb = root.querySelector('.rate--tmdb');
        var imdb = root.querySelector('.rate--imdb');
        restoreDetailElement(tmdb);

        if (imdb && imdb.getAttribute(ATTRIBUTES.detailCreated) === '1') {
            if (imdb.parentNode) imdb.parentNode.removeChild(imdb);
        } else if (imdb) {
            if (imdb.hasAttribute(ATTRIBUTES.detailOriginalText) && imdb.children[0]) {
                imdb.children[0].innerText = imdb.getAttribute(ATTRIBUTES.detailOriginalText) || '';
            }
            if (imdb.getAttribute(ATTRIBUTES.detailOriginalHadTitle) === '1') {
                imdb.setAttribute('title', imdb.getAttribute(ATTRIBUTES.detailOriginalTitle) || '');
            } else {
                imdb.removeAttribute('title');
            }
            restoreDetailElement(imdb);
            imdb.removeAttribute(ATTRIBUTES.detailOriginalText);
            imdb.removeAttribute(ATTRIBUTES.detailOriginalTitle);
            imdb.removeAttribute(ATTRIBUTES.detailOriginalHadTitle);
        }

        root.removeAttribute(ATTRIBUTES.detailLoading);
        root.removeAttribute(ATTRIBUTES.detailLoaded);
    }

    function applyTorrentResult(root, result) {
        if (!root) return;
        root.removeAttribute(ATTRIBUTES.torrentLoading);

        if (!document.documentElement.contains(root)) return;
        if (!result || result.rating == null) {
            root.setAttribute(ATTRIBUTES.torrentLoaded, '1');
            return;
        }

        var rate = root.querySelector('.explorer-card__head-rate');
        var value = rate && rate.querySelector('span');
        if (!rate || !value) return;

        if (!rate.hasAttribute(ATTRIBUTES.torrentOriginalHidden)) {
            rate.setAttribute(ATTRIBUTES.torrentOriginalHidden, rate.classList.contains('hide') ? '1' : '0');
            rate.setAttribute(ATTRIBUTES.torrentOriginalText, value.innerText || '');
            if (rate.hasAttribute('title')) {
                rate.setAttribute(ATTRIBUTES.torrentOriginalHadTitle, '1');
                rate.setAttribute(ATTRIBUTES.torrentOriginalTitle, rate.getAttribute('title') || '');
            }
        }

        rate.classList.remove('hide');
        value.innerText = formatRating(result.rating);
        rate.title = formatTooltip(result);
        root.setAttribute(ATTRIBUTES.torrentLoaded, '1');
    }

    function restoreTorrent(root) {
        if (!root) return;

        var rate = root.querySelector('.explorer-card__head-rate');
        var value = rate && rate.querySelector('span');
        if (rate && rate.hasAttribute(ATTRIBUTES.torrentOriginalHidden)) {
            if (value) value.innerText = rate.getAttribute(ATTRIBUTES.torrentOriginalText) || '';
            if (rate.getAttribute(ATTRIBUTES.torrentOriginalHadTitle) === '1') {
                rate.setAttribute('title', rate.getAttribute(ATTRIBUTES.torrentOriginalTitle) || '');
            } else {
                rate.removeAttribute('title');
            }
            if (rate.getAttribute(ATTRIBUTES.torrentOriginalHidden) === '1') rate.classList.add('hide');
            else rate.classList.remove('hide');

            rate.removeAttribute(ATTRIBUTES.torrentOriginalHidden);
            rate.removeAttribute(ATTRIBUTES.torrentOriginalText);
            rate.removeAttribute(ATTRIBUTES.torrentOriginalTitle);
            rate.removeAttribute(ATTRIBUTES.torrentOriginalHadTitle);
        }

        root.removeAttribute(ATTRIBUTES.torrentLoading);
        root.removeAttribute(ATTRIBUTES.torrentLoaded);
    }

    function formatRating(rating) {
        var value = Number(rating).toFixed(1);
        return shouldShowLabel() ? 'IMDb ' + value : value;
    }

    function formatTooltip(result) {
        var text = 'IMDb: ' + Number(result.rating).toFixed(1);
        return result.votes == null ? text : text + ' · ' + result.votes + ' votes';
    }

    function applyResult(card, result) {
        if (!card) return;
        card.removeAttribute(ATTRIBUTES.loading);

        if (!document.documentElement.contains(card)) return;
        if (!result || result.rating == null) {
            card.setAttribute(ATTRIBUTES.loaded, '1');
            return;
        }

        var vote = findOrCreateVote(card);
        if (!vote) return;

        rememberVoteState(vote);
        vote.innerText = formatRating(result.rating);
        vote.title = formatTooltip(result);
        vote.setAttribute(ATTRIBUTES.rating, result.rating);
        card.setAttribute(ATTRIBUTES.loaded, '1');
    }

    function releaseCard(card) {
        if (card) card.removeAttribute(ATTRIBUTES.loading);
    }

    function releaseDetail(root) {
        if (root) root.removeAttribute(ATTRIBUTES.detailLoading);
    }

    function releaseTorrent(root) {
        if (root) root.removeAttribute(ATTRIBUTES.torrentLoading);
    }

    function scheduleFlush() {
        clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }

    function enqueueCard(card, data) {
        if (!isEnabled() || !getServiceUrl() || !data) return;

        var request = createRequest(data);
        if (!request) return;

        var key = request.key;
        if (state.cache.has(key)) {
            applyResult(card, state.cache.get(key));
            return;
        }
        if (card.getAttribute(ATTRIBUTES.loading) === '1') return;

        card.setAttribute(ATTRIBUTES.loading, '1');
        var entry = state.queue.get(key);
        if (!entry) {
            entry = { item: request.item, cards: [], details: [], torrents: [] };
            state.queue.set(key, entry);
        }
        entry.cards.push(card);
        scheduleFlush();
    }

    function enqueueDetail(root, data) {
        if (!isEnabled() || !getServiceUrl() || !root || !data) return;

        var request = createRequest(data);
        if (!request) return;

        if (state.cache.has(request.key)) {
            applyDetailResult(root, state.cache.get(request.key));
            return;
        }
        if (root.getAttribute(ATTRIBUTES.detailLoading) === '1') return;

        root.setAttribute(ATTRIBUTES.detailLoading, '1');
        var entry = state.queue.get(request.key);
        if (!entry) {
            entry = { item: request.item, cards: [], details: [], torrents: [] };
            state.queue.set(request.key, entry);
        }
        if (!entry.details) entry.details = [];
        entry.details.push(root);
        scheduleFlush();
    }

    function enqueueTorrent(root, data) {
        if (!isEnabled() || !getServiceUrl() || !root || !data) return;

        var request = createRequest(data);
        if (!request) return;

        if (state.cache.has(request.key)) {
            applyTorrentResult(root, state.cache.get(request.key));
            return;
        }
        if (root.getAttribute(ATTRIBUTES.torrentLoading) === '1') return;

        root.setAttribute(ATTRIBUTES.torrentLoading, '1');
        var entry = state.queue.get(request.key);
        if (!entry) {
            entry = { item: request.item, cards: [], details: [], torrents: [] };
            state.queue.set(request.key, entry);
        }
        if (!entry.torrents) entry.torrents = [];
        entry.torrents.push(root);
        scheduleFlush();
    }

    function takeNextBatch() {
        var entries = Array.from(state.queue.entries()).slice(0, MAX_BATCH_SIZE);
        entries.forEach(function (entry) {
            state.queue.delete(entry[0]);
        });
        return entries;
    }

    function createHeaders() {
        var headers = { 'Content-Type': 'application/json' };
        var serviceToken = getServiceToken();
        if (serviceToken) headers['X-Api-Key'] = serviceToken;
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
            var error = new Error('Rating service returned HTTP ' + response.status + '.');
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
            queued.cards.forEach(function (card) {
                applyResult(card, result);
            });
            (queued.details || []).forEach(function (root) {
                applyDetailResult(root, result);
            });
            (queued.torrents || []).forEach(function (root) {
                applyTorrentResult(root, result);
            });
        });
    }

    function releaseBatch(entries) {
        entries.forEach(function (entry) {
            entry[1].cards.forEach(releaseCard);
            (entry[1].details || []).forEach(releaseDetail);
            (entry[1].torrents || []).forEach(releaseTorrent);
        });
    }

    async function processBatch(entries, generation, attempt) {
        try {
            var results = await requestRatings(entries);
            if (generation === state.generation) applyBatch(entries, results);
        } catch (error) {
            if (generation !== state.generation) return;

            var retryable = error.retryable !== false;
            if (retryable && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
                var retryDelay = REQUEST_RETRY_MS * Math.pow(2, attempt);
                console.log('IMDb rating request failed, retrying: ' + (error.message || String(error)));
                setTimeout(function () {
                    if (generation === state.generation) processBatch(entries, generation, attempt + 1);
                }, retryDelay);
                return;
            }

            console.log('IMDb rating request failed: ' + (error.message || String(error)));
            releaseBatch(entries);
        }
    }

    function flushQueue() {
        state.flushTimer = null;
        if (!state.queue.size) return;

        var entries = takeNextBatch();
        processBatch(entries, state.generation, 0);

        if (state.queue.size) scheduleFlush();
    }

    function processCard(card, attempt) {
        if (!card || card.getAttribute(ATTRIBUTES.loaded) === '1') return;

        attempt = attempt || 0;
        var data = card.card_data;

        if (!data) {
            if (attempt < CARD_DATA_RETRY_DELAYS.length) {
                setTimeout(function () {
                    if (document.documentElement.contains(card)) processCard(card, attempt + 1);
                }, CARD_DATA_RETRY_DELAYS[attempt]);
            }
            return;
        }

        if (data.media_type === 'person' || data.profile_path) return;
        enqueueCard(card, data);
    }

    function scanCards(root) {
        if (!isEnabled() || !getServiceUrl()) return;

        root = root || document;
        if (root.nodeType === 1 && root.classList && root.classList.contains('card')) {
            processCard(root);
        }
        if (!root.querySelectorAll) return;

        var cards = root.querySelectorAll(CARD_SELECTOR);
        for (var i = 0; i < cards.length; i++) processCard(cards[i]);
    }

    function processDetail(root) {
        if (!root || root.getAttribute(ATTRIBUTES.detailLoaded) === '1') return;
        enqueueDetail(root, root.imdb_detail_data);
    }

    function scanDetails() {
        if (!isEnabled() || !getServiceUrl()) return;

        var details = document.querySelectorAll('.full-start-new');
        for (var i = 0; i < details.length; i++) processDetail(details[i]);
    }

    function processTorrent(root) {
        if (!root || root.getAttribute(ATTRIBUTES.torrentLoaded) === '1') return;
        enqueueTorrent(root, root.imdb_torrent_data);
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
        if (root) {
            root.imdb_torrent_data = object.movie;
            processTorrent(root);
        }
    }

    function scanActiveTorrent() {
        if (!Lampa.Activity || !Lampa.Activity.active) return;
        processTorrentActivity(Lampa.Activity.active());
    }

    function clearCardState() {
        var cards = document.querySelectorAll(CARD_SELECTOR);
        for (var i = 0; i < cards.length; i++) {
            restoreVote(cards[i]);
            cards[i].removeAttribute(ATTRIBUTES.loaded);
            cards[i].removeAttribute(ATTRIBUTES.loading);
        }
    }

    function clearDetailState() {
        var details = document.querySelectorAll('.full-start-new');
        for (var i = 0; i < details.length; i++) restoreDetail(details[i]);
    }

    function clearTorrentState() {
        var torrents = document.querySelectorAll('.explorer');
        for (var i = 0; i < torrents.length; i++) restoreTorrent(torrents[i]);
    }

    function resetPlugin() {
        state.generation++;
        state.cache.clear();
        state.queue.clear();
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
        clearCardState();
        clearDetailState();
        clearTorrentState();
        setTimeout(function () {
            scanCards(document);
            scanDetails();
            scanActiveTorrent();
        }, START_RETRY_MS);
    }

    function addSetting(key, type, defaultValue, name, description) {
        if (state.registeredSettings[key]) return;

        var param = { name: key, type: type, default: defaultValue };

        // Lampa 3.2.8 calls Params.select() for input fields and expects
        // param.values to be a string. Without it, opening the settings page
        // fails while evaluating values[name][key].
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
        addSetting(SETTINGS.enabled, 'trigger', true, 'Use IMDb ratings', 'Replace poster ratings with IMDb ratings');
        addSetting(SETTINGS.label, 'trigger', false, 'Show IMDb label', 'Display IMDb 8.4 instead of 8.4');
    }

    function observeCards() {
        if (state.observer) return;

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                for (var i = 0; i < mutation.addedNodes.length; i++) {
                    if (mutation.addedNodes[i].nodeType === 1) scanCards(mutation.addedNodes[i]);
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

    function findDetailRoot(event) {
        var body = unwrapElement(event && event.body);

        if (body) {
            if (body.classList && body.classList.contains('full-start-new')) return body;
            if (body.querySelector) {
                var nested = body.querySelector('.full-start-new');
                if (nested) return nested;
            }
        }

        return document.querySelector('.full-start-new');
    }

    function getDetailMovie(event) {
        if (event && event.data && event.data.movie) return event.data.movie;
        if (event && event.movie) return event.movie;

        if (Lampa.Activity && Lampa.Activity.active) {
            var active = Lampa.Activity.active();
            if (active && active.movie) return active.movie;
        }

        return null;
    }

    function processFullEvent(event) {
        var movie = getDetailMovie(event);
        if (!movie) return;

        function apply() {
            var root = findDetailRoot(event);
            if (!root) return;

            root.imdb_detail_data = movie;
            processDetail(root);
        }

        apply();
        setTimeout(apply, 100);
        setTimeout(apply, 350);
    }

    function registerFullListener() {
        if (state.fullListenerRegistered || !Lampa.Listener) return;

        Lampa.Listener.follow('full', function (event) {
            if (!event || event.type !== 'complite') return;
            processFullEvent(event);
        });
        state.fullListenerRegistered = true;
    }

    function registerActivityListener() {
        if (state.activityListenerRegistered || !Lampa.Listener) return;

        Lampa.Listener.follow('activity', function (event) {
            if (!event || event.type !== 'start') return;
            processTorrentActivity(event.object);
        });
        state.activityListenerRegistered = true;
    }

    function startPlugin() {
        if (state.started) return;

        if (
            !window.Lampa ||
            !Lampa.Storage ||
            !Lampa.SettingsApi ||
            !Lampa.Listener ||
            !Lampa.Activity ||
            !document.body
        ) {
            return;
        }

        registerSettings();
        registerFullListener();
        registerActivityListener();
        observeCards();
        scanCards(document);
        scanActiveTorrent();

        state.started = true;

        console.log('[IMDb Ratings] plugin started');
    }

    function tryStartPlugin() {
        if (state.started) return;

        try {
            startPlugin();
        } catch (error) {
            console.log('[IMDb Ratings] startup error:', error);
        }

        if (!state.started) {
            setTimeout(tryStartPlugin, START_RETRY_MS);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryStartPlugin);
    }
    tryStartPlugin();
})();