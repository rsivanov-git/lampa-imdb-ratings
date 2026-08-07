(function () {
    'use strict';

    var PLUGIN_FLAG = 'lampa_imdb_batch_rating';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    var COMPONENT = 'imdb_batch_rating';
    var SETTINGS = {
        url: 'imdb_batch_url',
        token: 'imdb_batch_token',
        enabled: 'imdb_batch_enabled',
        label: 'imdb_batch_label'
    };
    var ATTRIBUTES = {
        loading: 'data-imdb-rating-loading',
        loaded: 'data-imdb-rating-loaded',
        rating: 'data-imdb-rating'
    };
    var CARD_SELECTOR = '.card';
    var BATCH_DELAY_MS = 120;
    var MAX_BATCH_SIZE = 60;
    var START_RETRY_MS = 250;

    var state = {
        cache: new Map(),
        queue: new Map(),
        flushTimer: null,
        generation: 0,
        started: false
    };

    function getSetting(key, defaultValue) {
        var value = Lampa.Storage.get(key, defaultValue);
        return value === undefined || value === null ? defaultValue : value;
    }

    function isEnabled() {
        return !!getSetting(SETTINGS.enabled, true);
    }

    function getServiceUrl() {
        return String(getSetting(SETTINGS.url, '') || '').replace(/\/+$/, '');
    }

    function getServiceToken() {
        return String(getSetting(SETTINGS.token, '') || '');
    }

    function shouldShowLabel() {
        return !!getSetting(SETTINGS.label, false);
    }

    function getMediaType(data) {
        return data.media_type === 'tv' || data.first_air_date || (data.name && !data.title) ? 'tv' : 'movie';
    }

    function getItemKey(data) {
        return getMediaType(data) + ':' + data.id;
    }

    function createRequestItem(data) {
        return {
            type: getMediaType(data),
            tmdb: Number(data.id),
            imdb: data.imdb_id || null
        };
    }

    function findOrCreateVote(card) {
        var vote = card.querySelector('.card__vote');
        if (vote) return vote;

        var view = card.querySelector('.card__view');
        if (!view) return null;

        vote = document.createElement('div');
        vote.classList.add('card__vote');
        view.appendChild(vote);
        return vote;
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

        vote.innerText = formatRating(result.rating);
        vote.title = formatTooltip(result);
        vote.setAttribute(ATTRIBUTES.rating, result.rating);
        card.setAttribute(ATTRIBUTES.loaded, '1');
    }

    function releaseCard(card) {
        if (card) card.removeAttribute(ATTRIBUTES.loading);
    }

    function scheduleFlush() {
        clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }

    function enqueueCard(card, data) {
        if (!isEnabled() || !getServiceUrl() || !data || !data.id) return;

        var key = getItemKey(data);
        if (state.cache.has(key)) {
            applyResult(card, state.cache.get(key));
            return;
        }
        if (card.getAttribute(ATTRIBUTES.loading) === '1') return;

        card.setAttribute(ATTRIBUTES.loading, '1');
        var entry = state.queue.get(key);
        if (!entry) {
            entry = { item: createRequestItem(data), cards: [] };
            state.queue.set(key, entry);
        }
        entry.cards.push(card);
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

        if (!response.ok) throw new Error('Rating service returned HTTP ' + response.status + '.');
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
        });
    }

    function releaseBatch(entries) {
        entries.forEach(function (entry) {
            entry[1].cards.forEach(releaseCard);
        });
    }

    async function flushQueue() {
        state.flushTimer = null;
        if (!state.queue.size) return;

        var entries = takeNextBatch();
        var generation = state.generation;
        try {
            var results = await requestRatings(entries);
            if (generation === state.generation) applyBatch(entries, results);
        } catch (error) {
            if (generation === state.generation) {
                console.log('IMDb rating request failed:', error);
                releaseBatch(entries);
            }
        }

        if (state.queue.size) scheduleFlush();
    }

    function processCard(card) {
        if (!card || card.getAttribute(ATTRIBUTES.loaded) === '1') return;

        var data = card.card_data;
        if (!data || data.media_type === 'person' || data.profile_path) return;
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

    function clearCardState() {
        var cards = document.querySelectorAll(CARD_SELECTOR);
        for (var i = 0; i < cards.length; i++) {
            cards[i].removeAttribute(ATTRIBUTES.loaded);
            cards[i].removeAttribute(ATTRIBUTES.loading);
        }
    }

    function resetPlugin() {
        state.generation++;
        state.cache.clear();
        state.queue.clear();
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
        clearCardState();
        setTimeout(function () { scanCards(document); }, START_RETRY_MS);
    }

    function addSetting(key, type, defaultValue, name, description) {
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: { name: key, type: type, default: defaultValue },
            field: { name: name, description: description },
            onChange: resetPlugin
        });
    }

    function registerSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: 'IMDb Ratings',
            icon: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" fill="currentColor"/></svg>'
        });
        addSetting(SETTINGS.url, 'input', '', 'Rating service URL', 'For example: https://ratings.example.com');
        addSetting(SETTINGS.token, 'input', '', 'Service token', 'Sent to the rating service as X-Api-Key');
        addSetting(SETTINGS.enabled, 'trigger', true, 'Use IMDb ratings', 'Replace poster ratings with IMDb ratings');
        addSetting(SETTINGS.label, 'trigger', false, 'Show IMDb label', 'Display IMDb 8.4 instead of 8.4');
    }

    function observeCards() {
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                for (var i = 0; i < mutation.addedNodes.length; i++) {
                    if (mutation.addedNodes[i].nodeType === 1) scanCards(mutation.addedNodes[i]);
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function startPlugin() {
        if (state.started) return;

        if (
            !window.Lampa ||
            !Lampa.Storage ||
            !Lampa.SettingsApi ||
            !document.body
        ) {
            return;
        }

        registerSettings();
        observeCards();
        scanCards(document);

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
