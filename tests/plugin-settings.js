'use strict';

var assert = require('assert');
var path = require('path');

function Element(classNames, tagName) {
    var element = this;
    var classes = (classNames || '').split(/\s+/).filter(Boolean);

    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.innerText = '';
    this.classList = {
        add: function (name) { if (classes.indexOf(name) === -1) classes.push(name); },
        contains: function (name) { return classes.indexOf(name) !== -1; },
        remove: function (name) {
            var index = classes.indexOf(name);
            if (index !== -1) classes.splice(index, 1);
        }
    };

    Object.defineProperty(this, 'title', {
        get: function () { return element.getAttribute('title') || ''; },
        set: function (value) { element.setAttribute('title', value); }
    });
}

Element.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
};
Element.prototype.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
};
Element.prototype.hasAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
};
Element.prototype.removeAttribute = function (name) {
    delete this.attributes[name];
};
Element.prototype.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
};
Element.prototype.removeChild = function (child) {
    var index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
};
Element.prototype.querySelector = function (selector) {
    var isClass = selector.charAt(0) === '.';
    var name = isClass ? selector.slice(1) : selector.toUpperCase();
    for (var i = 0; i < this.children.length; i++) {
        if (isClass ? this.children[i].classList.contains(name) : this.children[i].tagName === name) return this.children[i];
        var nested = this.children[i].querySelector(selector);
        if (nested) return nested;
    }
    return null;
};
Element.prototype.querySelectorAll = function (selector) {
    var matches = [];
    var className = selector.charAt(0) === '.' ? selector.slice(1) : '';
    for (var i = 0; i < this.children.length; i++) {
        if (this.children[i].classList.contains(className)) matches.push(this.children[i]);
        matches = matches.concat(this.children[i].querySelectorAll(selector));
    }
    return matches;
};

function createCard(data, rating, title) {
    var card = new Element('card');
    var view = new Element('card__view');
    var vote = new Element('card__vote');
    card.card_data = data;
    vote.innerText = rating;
    if (title !== undefined) vote.setAttribute('title', title);
    view.appendChild(vote);
    card.appendChild(view);
    return { card: card, vote: vote };
}

function createDetail(rating) {
    var body = new Element('full-body');
    var root = new Element('full-start-new');
    var line = new Element('full-start-new__rate-line');
    var tmdb = new Element('full-start__rate rate--tmdb');
    var imdb = new Element('full-start__rate rate--imdb hide');
    var tmdbValue = new Element();
    var imdbValue = new Element();

    tmdbValue.innerText = rating;
    tmdb.appendChild(tmdbValue);
    imdb.appendChild(imdbValue);
    imdb.appendChild(new Element());
    line.appendChild(tmdb);
    line.appendChild(imdb);
    root.appendChild(line);
    body.appendChild(root);
    return { body: body, root: root, tmdb: tmdb, imdb: imdb, imdbValue: imdbValue };
}

function createTorrentDetail(rating) {
    var body = new Element('activity-body');
    var root = new Element('explorer');
    var rate = new Element('explorer-card__head-rate');
    var value = new Element('', 'span');

    value.innerText = rating;
    rate.appendChild(value);
    root.appendChild(rate);
    body.appendChild(root);
    return { body: body, root: root, rate: rate, value: value };
}

function delay(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

(async function () {
    var registeredParams = [];
    var componentRegistrations = 0;
    var componentIcon = '';
    var observerAttempts = 0;
    var fetchAttempts = 0;
    var requestBodies = [];
    var fullListeners = [];
    var activityListeners = [];
    var activeActivity = null;
    var settings = {
        imdb_batch_url: 'https://ratings.example.com',
        imdb_batch_token: 'test-token',
        imdb_batch_label: false
    };
    var valid = createCard({ id: 278, media_type: 'movie' }, '8.0', 'TMDB rating');
    var missing = createCard({ id: 95350, media_type: 'tv' }, '8.2', 'TMDB rating');
    var invalid = createCard({ id: 'custom-card', media_type: 'movie' }, '7.0');
    var detail = createDetail('8.0');
    var missingDetail = createDetail('8.2');
    var torrentDetail = createTorrentDetail('8.0');
    var missingTorrentDetail = createTorrentDetail('8.2');
    var cards = [valid.card, missing.card, invalid.card];
    var detailRoots = [detail.root, missingDetail.root];
    var torrentRoots = [torrentDetail.root, missingTorrentDetail.root];

    global.window = {};
    global.document = {
        body: new Element('body'),
        documentElement: {
            contains: function (element) {
                return cards.indexOf(element) !== -1 || detailRoots.indexOf(element) !== -1 || torrentRoots.indexOf(element) !== -1;
            }
        },
        readyState: 'complete',
        createElement: function (tagName) { return new Element('', tagName); },
        querySelectorAll: function (selector) {
            if (selector === '.card') return cards;
            if (selector === '.full-start-new') return detailRoots;
            if (selector === '.explorer') return torrentRoots;
            return [];
        },
        addEventListener: function () {}
    };
    global.MutationObserver = function () {
        this.observe = function () {
            observerAttempts++;
            if (observerAttempts === 1) throw new Error('Simulated observer startup failure');
        };
    };
    global.Lampa = {
        Storage: {
            get: function (key, defaultValue) {
                return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue;
            }
        },
        SettingsApi: {
            addComponent: function (component) {
                componentRegistrations++;
                componentIcon = component.icon;
            },
            addParam: function (setting) {
                if (setting.param.type === 'input') {
                    assert.strictEqual(typeof setting.param.values, 'string');
                }
                registeredParams.push(setting);
            }
        },
        Listener: {
            follow: function (name, listener) {
                if (name === 'full') fullListeners.push(listener);
                else if (name === 'activity') activityListeners.push(listener);
                else assert.fail('Unexpected listener: ' + name);
            }
        },
        Activity: {
            active: function () { return activeActivity; }
        },
        Card: function (data) {
            this.data = data || {};
            this.html = new Element('card');
        }
    };
    global.Lampa.Card.prototype.create = function () { return this; };
    global.Lampa.Card.prototype.render = function () { return this.html; };
    window.Lampa = global.Lampa;

    global.fetch = function (url, options) {
        fetchAttempts++;
        requestBodies.push(JSON.parse(options.body));
        assert.strictEqual(url, 'https://ratings.example.com/api/ratings');
        assert.strictEqual(options.headers['X-Api-Key'], 'test-token');

        if (fetchAttempts === 1) return Promise.reject(new Error('Simulated network failure'));
        return Promise.resolve({
            ok: true,
            json: function () {
                return Promise.resolve({
                    items: {
                        'movie:278': { rating: 9.3, votes: 3100000 },
                        'tv:95350': { imdb: 'tt26545992', rating: null, votes: null }
                    }
                });
            }
        });
    };

    require(path.resolve(__dirname, '../plugin/imdb-ratings.js'));
    await delay(1200);

    assert.strictEqual(componentRegistrations, 1, 'Startup retry must not duplicate the component');
    assert.ok(componentIcon.indexOf('<title>IMDb</title>') !== -1, 'Settings must use the IMDb icon');
    assert.ok(componentIcon.indexOf('<rect') === -1, 'Settings must not use the placeholder icon');
    assert.strictEqual(registeredParams.length, 3, 'Plugin must expose URL, token, and label settings only');
    assert.strictEqual(registeredParams.some(function (entry) { return entry.param.name === 'imdb_batch_enabled'; }), false, 'Use IMDb ratings toggle must be removed');
    assert.strictEqual(fullListeners.length, 1, 'Startup retry must not duplicate the full-screen listener');
    assert.strictEqual(activityListeners.length, 1, 'Startup retry must not duplicate the activity listener');
    assert.strictEqual(observerAttempts, 2, 'Observer startup should be retried once');
    assert.strictEqual(fetchAttempts, 2, 'A transient network error should be retried');
    assert.strictEqual(requestBodies[0].items.length, 2, 'Invalid card IDs must not enter the batch');
    assert.ok(requestBodies[0].items.some(function (item) { return item.type === 'movie' && item.tmdb === 278; }));
    assert.ok(requestBodies[0].items.some(function (item) { return item.type === 'tv' && item.tmdb === 95350; }));

    assert.strictEqual(valid.vote.innerText, '9.3');
    assert.strictEqual(valid.vote.classList.contains('hide'), false);
    assert.strictEqual(valid.vote.getAttribute('title'), 'IMDb: 9.3 · 3100000 votes');

    assert.strictEqual(missing.vote.classList.contains('hide'), true, 'TMDB card rating must be hidden when IMDb is unavailable');
    assert.strictEqual(missing.vote.getAttribute('title'), null);

    assert.strictEqual(invalid.vote.innerText, '7.0');
    assert.strictEqual(invalid.card.hasAttribute('data-imdb-rating-loading'), false);

    fullListeners[0]({
        type: 'complite',
        body: { 0: detail.body },
        data: { movie: { id: 278, media_type: 'movie' } }
    });

    assert.strictEqual(detail.tmdb.classList.contains('hide'), true, 'TMDB rating must be hidden in details');
    assert.strictEqual(detail.imdb.classList.contains('hide'), false, 'IMDb rating must be visible in details');
    assert.strictEqual(detail.imdbValue.innerText, '9.3');
    assert.strictEqual(detail.imdb.getAttribute('title'), 'IMDb: 9.3 · 3100000 votes');

    fullListeners[0]({
        type: 'complite',
        body: { 0: missingDetail.body },
        data: { movie: { id: 95350, media_type: 'tv' } }
    });

    assert.strictEqual(missingDetail.tmdb.classList.contains('hide'), true, 'TMDB detail rating must stay hidden when IMDb is unavailable');
    assert.strictEqual(missingDetail.imdb.classList.contains('hide'), true, 'Empty IMDb detail block must stay hidden');

    activeActivity = {
        component: 'torrents',
        movie: { id: 278, media_type: 'movie' },
        activity: { render: function () { return { 0: torrentDetail.body }; } }
    };
    activityListeners[0]({ type: 'start', object: activeActivity });

    assert.strictEqual(torrentDetail.value.innerText, '9.3', 'Torrent details must show the IMDb rating');
    assert.strictEqual(torrentDetail.rate.classList.contains('hide'), false);
    assert.strictEqual(torrentDetail.rate.getAttribute('title'), 'IMDb: 9.3 · 3100000 votes');

    activeActivity = {
        component: 'torrents',
        movie: { id: 95350, media_type: 'tv' },
        activity: { render: function () { return { 0: missingTorrentDetail.body }; } }
    };
    activityListeners[0]({ type: 'start', object: activeActivity });

    assert.strictEqual(missingTorrentDetail.rate.classList.contains('hide'), true, 'Torrent TMDB rating must be hidden when IMDb is unavailable');
    assert.strictEqual(missingTorrentDetail.rate.getAttribute('title'), null);

    console.log('Plugin compatibility tests passed.');
})().catch(function (error) {
    console.error(error);
    process.exitCode = 1;
});
