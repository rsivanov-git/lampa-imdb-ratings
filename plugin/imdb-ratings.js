(function () {
    'use strict';

    var PLUGIN_FLAG = 'lampa_imdb_batch_rating';
    if (window[PLUGIN_FLAG]) return;
    window[PLUGIN_FLAG] = true;

    var VERSION = '7.0.0';
    var COMPONENT = 'imdb_batch_rating';
    var SETTINGS = {
        url: 'imdb_batch_url',
        token: 'imdb_batch_token',
        enabled: 'imdb_batch_enabled',
        label: 'imdb_batch_label'
    };
    var ATTR = {
        loading: 'data-imdb-rating-loading',
        loaded: 'data-imdb-rating-loaded',
        detailLoading: 'data-imdb-detail-loading',
        detailLoaded: 'data-imdb-detail-loaded',
        torrentLoading: 'data-imdb-torrent-loading',
        torrentLoaded: 'data-imdb-torrent-loaded'
    };

    var state = {
        started: false,
        cardPatched: false,
        fullListenerRegistered: false,
        activityListenerRegistered: false,
        componentRegistered: false,
        registeredSettings: {},
        queue: new Map(),
        cache: new Map(),
        timer: null,
        generation: 0
    };

    function getSetting(key, fallback) {
        var value = Lampa.Storage.get(key, fallback);
        return value === undefined || value === null ? fallback : value;
    }

    function enabled() {
        return !!getSetting(SETTINGS.enabled, true);
    }

    function serviceUrl() {
        return String(getSetting(SETTINGS.url, '') || '').trim().replace(/\/+$/, '');
    }

    function serviceToken() {
        return String(getSetting(SETTINGS.token, '') || '').trim();
    }

    function showLabel() {
        return !!getSetting(SETTINGS.label, false);
    }

    function mediaType(data) {
        if (!data) return 'movie';

        var explicit = String(data.media_type || data.type || data.method || '').toLowerCase();
        if (explicit === 'tv' || explicit === 'series' || explicit === 'serial') return 'tv';
        if (explicit === 'movie') return 'movie';

        // TMDB TV objects consistently carry original_name. Lampa.Card also
        // copies name -> title, so `name && !title` is not reliable in 3.2.8.
        if (data.original_name) return 'tv';
        if (data.first_air_date) return 'tv';
        if (data.number_of_seasons != null || data.number_of_episodes != null) return 'tv';
        if (data.seasons && data.seasons.length) return 'tv';

        return 'movie';
    }

    function tmdbId(value) {
        var id = Number(value);
        return isFinite(id) && id > 0 && Math.floor(id) === id ? id : 0;
    }

    function imdbId(value) {
        value = String(value || '');
        return /^tt\d+$/.test(value) ? value : null;
    }

    function requestFor(data) {
        if (!data) return null;
        var type = mediaType(data);
        var tmdb = tmdbId(data.id);
        var imdb = imdbId(data.imdb_id || data.imdbId);
        if (!tmdb && !imdb) return null;

        return {
            key: tmdb ? type + ':' + tmdb : 'imdb:' + imdb,
            item: { type: type, tmdb: tmdb || null, imdb: imdb || null }
        };
    }

    function ratingText(rating) {
        var value = Number(rating).toFixed(1);
        return showLabel() ? 'IMDb ' + value : value;
    }

    function tooltip(result) {
        var text = 'IMDb: ' + Number(result.rating).toFixed(1);
        if (result.votes != null) text += ' · ' + result.votes + ' votes';
        return text;
    }

    function applyCard(card, result) {
        if (!card) return;
        card.removeAttribute(ATTR.loading);
        if (!result || result.rating == null) {
            card.setAttribute(ATTR.loaded, '1');
            return;
        }

        var vote = card.querySelector('.card__vote');
        if (!vote) {
            var view = card.querySelector('.card__view');
            if (!view) return;
            vote = document.createElement('div');
            vote.className = 'card__vote';
            view.appendChild(vote);
        }

        vote.innerText = ratingText(result.rating);
        vote.title = tooltip(result);
        card.setAttribute(ATTR.loaded, '1');
    }

    function applyDetail(root, result) {
        if (!root) return;
        root.removeAttribute(ATTR.detailLoading);
        if (!result || result.rating == null) {
            root.setAttribute(ATTR.detailLoaded, '1');
            return;
        }

        var tmdb = root.querySelector('.rate--tmdb');
        var imdb = root.querySelector('.rate--imdb');

        if (!imdb) {
            var line = root.querySelector('.full-start-new__rate-line');
            if (!line) return;
            imdb = document.createElement('div');
            imdb.className = 'full-start__rate rate--imdb';
            var value = document.createElement('div');
            var source = document.createElement('div');
            source.innerText = 'IMDB';
            imdb.appendChild(value);
            imdb.appendChild(source);
            line.appendChild(imdb);
        }

        if (tmdb) tmdb.classList.add('hide');
        imdb.classList.remove('hide');
        if (imdb.children[0]) imdb.children[0].innerText = Number(result.rating).toFixed(1);
        imdb.title = tooltip(result);
        root.setAttribute(ATTR.detailLoaded, '1');
    }

    function applyTorrent(root, result) {
        if (!root) return;
        root.removeAttribute(ATTR.torrentLoading);
        if (!result || result.rating == null) {
            root.setAttribute(ATTR.torrentLoaded, '1');
            return;
        }

        var rate = root.querySelector('.explorer-card__head-rate');
        var value = rate && rate.querySelector('span');
        if (!rate || !value) return;

        rate.classList.remove('hide');
        value.innerText = ratingText(result.rating);
        rate.title = tooltip(result);
        root.setAttribute(ATTR.torrentLoaded, '1');
    }

    function queueEntry(req) {
        var entry = state.queue.get(req.key);
        if (!entry) {
            entry = { item: req.item, cards: [], details: [], torrents: [] };
            state.queue.set(req.key, entry);
        }
        return entry;
    }

    function enqueueCard(card, data) {
        if (!enabled() || !serviceUrl() || !card || !data) return;
        if (data.media_type === 'person' || data.profile_path) return;

        var req = requestFor(data);
        if (!req) return;

        if (state.cache.has(req.key)) {
            applyCard(card, state.cache.get(req.key));
            return;
        }
        if (card.getAttribute(ATTR.loading) === '1') return;

        card.setAttribute(ATTR.loading, '1');
        queueEntry(req).cards.push(card);
        schedule();
    }

    function enqueueDetail(root, data) {
        if (!enabled() || !serviceUrl() || !root || !data) return;
        var req = requestFor(data);
        if (!req) return;

        if (state.cache.has(req.key)) {
            applyDetail(root, state.cache.get(req.key));
            return;
        }
        if (root.getAttribute(ATTR.detailLoading) === '1') return;

        root.setAttribute(ATTR.detailLoading, '1');
        queueEntry(req).details.push(root);
        schedule();
    }

    function enqueueTorrent(root, data) {
        if (!enabled() || !serviceUrl() || !root || !data) return;
        var req = requestFor(data);
        if (!req) return;

        if (state.cache.has(req.key)) {
            applyTorrent(root, state.cache.get(req.key));
            return;
        }
        if (root.getAttribute(ATTR.torrentLoading) === '1') return;

        root.setAttribute(ATTR.torrentLoading, '1');
        queueEntry(req).torrents.push(root);
        schedule();
    }

    function schedule() {
        clearTimeout(state.timer);
        state.timer = setTimeout(flush, 100);
    }

    async function flush() {
        state.timer = null;
        if (!state.queue.size) return;

        var entries = Array.from(state.queue.entries()).slice(0, 60);
        entries.forEach(function (entry) { state.queue.delete(entry[0]); });
        var generation = state.generation;

        try {
            var headers = { 'Content-Type': 'application/json' };
            var token = serviceToken();
            if (token) headers['X-Api-Key'] = token;

            var response = await fetch(serviceUrl() + '/api/ratings', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    items: entries.map(function (entry) { return entry[1].item; })
                })
            });

            if (!response.ok) throw new Error('HTTP ' + response.status);
            var payload = await response.json();
            if (generation !== state.generation) return;
            var results = payload.items || {};

            entries.forEach(function (entry) {
                var key = entry[0];
                var targets = entry[1];
                var result = results[key] || { rating: null, votes: null };
                state.cache.set(key, result);
                targets.cards.forEach(function (card) { applyCard(card, result); });
                targets.details.forEach(function (root) { applyDetail(root, result); });
                targets.torrents.forEach(function (root) { applyTorrent(root, result); });
            });
        } catch (error) {
            console.log('[IMDb Ratings] request failed:', error.message || String(error));
            entries.forEach(function (entry) {
                entry[1].cards.forEach(function (card) { if (card) card.removeAttribute(ATTR.loading); });
                entry[1].details.forEach(function (root) { if (root) root.removeAttribute(ATTR.detailLoading); });
                entry[1].torrents.forEach(function (root) { if (root) root.removeAttribute(ATTR.torrentLoading); });
            });
        }

        if (state.queue.size) schedule();
    }

    function cardElement(instance) {
        if (!instance) return null;
        if (instance.render) {
            var rendered = instance.render(true);
            if (rendered && rendered.nodeType === 1) return rendered;
        }
        return instance.html && instance.html.nodeType === 1 ? instance.html : null;
    }

    function patchCard() {
        if (state.cardPatched || !Lampa.Card || !Lampa.Card.prototype) return;
        var proto = Lampa.Card.prototype;
        var original = proto.create;
        if (typeof original !== 'function') return;
        if (original.__imdbRatingsPatched) {
            state.cardPatched = true;
            return;
        }

        function patchedCreate() {
            var result = original.apply(this, arguments);
            try {
                var element = cardElement(this);
                if (element && this.data) {
                    element.card_data = this.data;
                    enqueueCard(element, this.data);
                }
            } catch (error) {
                console.log('[IMDb Ratings] card hook error:', error.message || String(error));
            }
            return result;
        }

        patchedCreate.__imdbRatingsPatched = true;
        proto.create = patchedCreate;
        state.cardPatched = true;
    }

    function fullRoot(event) {
        if (event && event.type === 'build' && event.name === 'start' && event.item && event.item.render) {
            var direct = event.item.render(true);
            if (direct && direct.nodeType === 1) return direct;
        }
        var body = event && event.body;
        body = body && body[0] ? body[0] : body;
        if (!body) return null;
        if (body.classList && body.classList.contains('full-start-new')) return body;
        return body.querySelector ? body.querySelector('.full-start-new') : null;
    }

    function fullMovie(event) {
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

    function registerFull() {
        if (state.fullListenerRegistered || !Lampa.Listener) return;
        Lampa.Listener.follow('full', function (event) {
            if (!event) return;
            if (!(event.type === 'build' && event.name === 'start') && event.type !== 'complite') return;
            var root = fullRoot(event);
            var movie = fullMovie(event);
            if (root && movie) enqueueDetail(root, movie);
        });
        state.fullListenerRegistered = true;
    }

    function torrentRoot(object) {
        if (!object || !object.activity || !object.activity.render) return null;
        var rendered = object.activity.render();
        var body = rendered && rendered[0] ? rendered[0] : rendered;
        if (!body) return null;
        if (body.classList && body.classList.contains('explorer')) return body;
        return body.querySelector ? body.querySelector('.explorer') : null;
    }

    function processTorrentActivity(object) {
        if (!object || object.component !== 'torrents' || !object.movie) return;
        var root = torrentRoot(object);
        if (root) enqueueTorrent(root, object.movie);
    }

    function registerActivity() {
        if (state.activityListenerRegistered || !Lampa.Listener) return;
        Lampa.Listener.follow('activity', function (event) {
            if (event && event.type === 'start') processTorrentActivity(event.object);
        });
        state.activityListenerRegistered = true;
    }

    function reset() {
        state.generation++;
        state.queue.clear();
        state.cache.clear();
        clearTimeout(state.timer);
        state.timer = null;

        document.querySelectorAll('.card').forEach(function (card) {
            card.removeAttribute(ATTR.loading);
            card.removeAttribute(ATTR.loaded);
            if (card.card_data) enqueueCard(card, card.card_data);
        });
        document.querySelectorAll('.full-start-new').forEach(function (root) {
            root.removeAttribute(ATTR.detailLoading);
            root.removeAttribute(ATTR.detailLoaded);
        });
    }

    function addSetting(key, type, fallback, name, description) {
        if (state.registeredSettings[key]) return;
        var param = { name: key, type: type, default: fallback };
        if (type === 'input') param.values = '';
        Lampa.SettingsApi.addParam({
            component: COMPONENT,
            param: param,
            field: { name: name, description: description },
            onChange: reset
        });
        state.registeredSettings[key] = true;
    }

    function registerSettings() {
        if (!Lampa.SettingsApi) return;
        if (!state.componentRegistered) {
            Lampa.SettingsApi.addComponent({
                component: COMPONENT,
                name: 'IMDb Ratings',
                icon: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" fill="currentColor"/></svg>'
            });
            state.componentRegistered = true;
        }

        addSetting(SETTINGS.url, 'input', '', 'Rating service URL', 'For example: https://ratings.example.com');
        addSetting(SETTINGS.token, 'input', '', 'Service token', 'Sent as X-Api-Key');
        addSetting(SETTINGS.enabled, 'trigger', true, 'Use IMDb ratings', 'Replace Lampa ratings with IMDb ratings');
        addSetting(SETTINGS.label, 'trigger', false, 'Show IMDb label', 'Display IMDb 8.4 instead of 8.4');
    }

    function start() {
        if (state.started) return;
        if (!window.Lampa || !Lampa.Storage || !Lampa.SettingsApi || !Lampa.Listener || !Lampa.Card || !document.body) return;
        registerSettings();
        patchCard();
        registerFull();
        registerActivity();
        state.started = true;
        console.log('[IMDb Ratings] v' + VERSION + ' started');
    }

    function tryStart() {
        if (state.started) return;
        try { start(); }
        catch (error) { console.log('[IMDb Ratings] startup error:', error.message || String(error)); }
        if (!state.started) setTimeout(tryStart, 250);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryStart);
    tryStart();
})();