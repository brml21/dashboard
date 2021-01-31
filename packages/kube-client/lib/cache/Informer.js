//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const EventEmitter = require('events')
const Reflector = require('./Reflector')
const Store = require('./Store')

const kReflector = Symbol('reflector')
const kStore = Symbol('store')

class Informer extends EventEmitter {
  constructor (listWatcher) {
    super()
    const store = this[kStore] = new Store()
    const informer = this
    this[kReflector] = Reflector.create(listWatcher, {
      replace (...args) {
        store.replace(...args)
        informer.emit('REPLACE', ...args)
      },
      add (object) {
        store.add(object)
        informer.emit('ADD', object)
      },
      update (object) {
        store.update(object)
        informer.emit('UPDATE', object)
      },
      delete (object) {
        store.delete(object)
        informer.emit('DELETE', object)
      }
    })
  }

  get store () {
    return this[kStore]
  }

  get hasSynced () {
    return this[kStore].hasSynced
  }

  get lastSyncResourceVersion () {
    return this[kReflector].lastSyncResourceVersion
  }

  run (signal) {
    const ac = new AbortController()
    if (signal instanceof AbortSignal) {
      signal.addEventListener('abort', () => {
        ac.abort()
      }, { once: true })
    }
    this[kReflector].run(ac.signal)
    return () => ac.abort()
  }

  static create (listWatcher) {
    return new this(listWatcher)
  }
}

module.exports = Informer
