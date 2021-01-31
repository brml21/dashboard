//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const request = require('@gardener-dashboard/request')
const { http } = require('./symbols')

class HttpClient {
  constructor ({ url, ...options } = {}) {
    this[http.client] = request.extend({
      prefixUrl: this.constructor[http.prefixUrl](url),
      ...options
    })
  }

  [http.request] (url, { searchParams, ...options } = {}) {
    if (searchParams && searchParams.toString()) {
      options.searchParams = searchParams
    }
    return this[http.client].request(url, options)
  }

  [http.stream] (url, options = {}) {
    return this[http.client].stream(url, options)
  }

  static [http.prefixUrl] (url) {
    return url
  }
}

module.exports = HttpClient
