//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const kQueue = Symbol('queue')
const kMaxConcurrency = Symbol('maxConcurrency')
const kConcurrency = Symbol('concurrency')
const kReleased = Symbol('released')

class Semaphore {
  constructor (maxConcurrency = 100) {
    this[kMaxConcurrency] = maxConcurrency
    this[kConcurrency] = 0
    this[kQueue] = []
  }

  set maxConcurrency (value) {
    this[kMaxConcurrency] = value
    this.dispatch()
  }

  get value () {
    return this[kMaxConcurrency] - this[kConcurrency] - this[kQueue].length
  }

  acquire () {
    const ticket = new Promise(resolve => {
      resolve[kReleased] = false
      this[kQueue].push(resolve)
    })
    this.dispatch()
    return ticket
  }

  dispatch () {
    while (this[kConcurrency] < this[kMaxConcurrency] && this[kQueue].length) {
      const resolve = this[kQueue].shift()
      this[kConcurrency]++
      const releaser = () => {
        if (!resolve[kReleased]) {
          resolve[kReleased] = true
          this[kConcurrency]--
          this.dispatch()
        }
      }
      resolve(releaser)
    }
  }
}

module.exports = Semaphore
