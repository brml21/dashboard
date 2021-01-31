//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const kList = Symbol('list')

class ListWatcher {
  constructor (listFunc, { group, version, names }, query = {}) {
    this[kList] = listFunc
    Object.assign(this, { group, version, names })
    this.searchParams = new URLSearchParams(query)
  }

  setAbortSignal (signal) {
    Object.defineProperty(this, 'signal', { value: signal })
  }

  mergeSearchParams (query = {}) {
    const searchParams = new URLSearchParams(this.searchParams.toString())
    for (const [key, value] of Object.entries(query)) {
      searchParams.set(key, value)
    }
    return searchParams
  }

  list (query) {
    const searchParams = this.mergeSearchParams(query)
    return this[kList]({ searchParams })
  }

  watch (query) {
    const searchParams = this.mergeSearchParams({ ...query, watch: true })
    const options = { searchParams }
    if (this.signal instanceof AbortSignal) {
      options.signal = this.signal
    }
    return this[kList](options)
  }
}

module.exports = ListWatcher
