'use strict';

var assert = require('assert');
var path = require('path');

function Element(classNames) {
    var element = this;
    var classes = (classNames || '').split(/\s+/).filter(Boolean);

    this.nodeType = 1;
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.innerText = '';
    this.classList = {
        add: function (name) { if (classes.indexOf(name) === -1) classes.push(name); },
        contains: function (name) { return classes.indexOf(name) !== -1; }
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
    var className = selector.charAt(0) === '.' ? selector.slice(1) : '';
    for (var i = 0; i < this.children.length; i++) {
        if (this.children[i].classList.contains(className)) return this.children[i];
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

function delay(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

(async function () {
    var registeredParams = [];
    var componentRegistrations = 0;
    var observerAttempts = 0;
    var fetchAttempts = 0;
    var requestBodies = [];
    var settings = {
        imdb_batch_url: 'https://ratings.example.com',
        imdb_batch_token: 'test-token',
        imdb_batch_enabled: true,
        imdb_batch_label: false
    };
    var valid = createCard({ id: 278, media_type: 'movie' }, '8.0', 'TMDB rating');
    var invalid = createCard({ id: 'custom-card', media_type: 'movie' }, '7.0');
    var cards = [valid.card, invalid.card];

    global.window = {};
    global.document = {
        body: new Element('body'),
        documentElement: { contains: function (element) { return cards.indexOf(element) !== -1; } },
        readyState: 'complete',
        createElement: function () { return new Element(); },
        querySelectorAll: function (selector) { return selector === '.card' ? cards : []; },
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
            addComponent: function () { componentRegistrations++; },
            addParam: function (setting) {
                if (setting.param.type === 'input') {
                    assert.strictEqual(typeof setting.param.values, 'string');
                }
                registeredParams.push(setting);
            }
        }
    };
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
                    items: { 'movie:278': { rating: 9.3, votes: 3100000 } }
                });
            }
        });
    };

    require(path.resolve(__dirname, '../plugin/imdb-ratings.js'));
    await delay(1200);

    assert.strictEqual(componentRegistrations, 1, 'Startup retry must not duplicate the component');
    assert.strictEqual(registeredParams.length, 4, 'Startup retry must not duplicate settings');
    assert.strictEqual(observerAttempts, 2, 'Observer startup should be retried once');
    assert.strictEqual(fetchAttempts, 2, 'A transient network error should be retried');
    assert.strictEqual(requestBodies[0].items.length, 1, 'Invalid card IDs must not enter the batch');
    assert.deepStrictEqual(requestBodies[0].items[0], { type: 'movie', tmdb: 278, imdb: null });
    assert.strictEqual(valid.vote.innerText, '9.3');
    assert.strictEqual(valid.vote.getAttribute('title'), 'IMDb: 9.3 · 3100000 votes');
    assert.strictEqual(invalid.vote.innerText, '7.0');
    assert.strictEqual(invalid.card.hasAttribute('data-imdb-rating-loading'), false);

    settings.imdb_batch_enabled = false;
    registeredParams.find(function (entry) {
        return entry.param.name === 'imdb_batch_enabled';
    }).onChange();

    assert.strictEqual(valid.vote.innerText, '8.0', 'Disabling must restore the original rating');
    assert.strictEqual(valid.vote.getAttribute('title'), 'TMDB rating', 'Disabling must restore the original tooltip');
    assert.strictEqual(valid.vote.hasAttribute('data-imdb-rating'), false);

    console.log('Plugin compatibility tests passed.');
})().catch(function (error) {
    console.error(error);
    process.exitCode = 1;
});
