//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const { get, matches, matchesProperty, property, isPlainObject } = require('lodash')

const kStore = Symbol('store')
const kKeyPath = Symbol('keyPath')
const kKeyFunc = Symbol('keyFunc')
const kHasSynced = Symbol('hasSynced')
const kSetSynced = Symbol('setSynced')

class Store {
  constructor (map = new Map(), options = {}) {
    this[kStore] = map
    this[kHasSynced] = new Promise(resolve => (this[kSetSynced] = resolve))
    this[kKeyPath] = get(options, 'keyPath', 'metadata.uid')
  }

  [kKeyFunc] (object) {
    return get(object, this[kKeyPath])
  }

  get hasSynced () {
    return this[kHasSynced]
  }

  listKeys () {
    return Array.from(this[kStore].keys())
  }

  list () {
    return Array.from(this[kStore].values())
  }

  clear () {
    this[kStore].clear()
  }

  delete (object) {
    const key = this[kKeyFunc](object)
    this[kStore].delete(key)
  }

  getByKey (key) {
    return this[kStore].get(key)
  }

  get (object) {
    const key = this[kKeyFunc](object)
    return this.getByKey(key)
  }

  find (predicate) {
    if (typeof predicate === 'string') {
      predicate = property(predicate)
    } else if (Array.isArray(predicate)) {
      predicate = matchesProperty(...predicate)
    } else if (isPlainObject(predicate)) {
      predicate = matches(predicate)
    } else if (typeof predicate !== 'function') {
      throw new TypeError('Invalid predicate argument')
    }
    for (const object of this[kStore].values()) {
      if (predicate(object)) {
        return object
      }
    }
  }

  hasByKey (key) {
    return this[kStore].has(key)
  }

  has (object) {
    const key = this[kKeyFunc](object)
    return this.hasByKey(key)
  }

  add (object) {
    const key = this[kKeyFunc](object)
    this[kStore].set(key, object)
  }

  update (object) {
    const key = this[kKeyFunc](object)
    this[kStore].set(key, object)
  }

  replace (items) {
    this.clear()
    for (const object of items) {
      const key = this[kKeyFunc](object)
      this[kStore].set(key, object)
    }
    this[kSetSynced](true)
  }
}

module.exports = Store
