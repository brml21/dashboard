//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const { join } = require('path')
const http = require('http')
const http2 = require('http2')
const createError = require('http-errors')
const typeis = require('type-is')
const { globalAgent } = require('./Agent')

const {
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_CONTENT_LENGTH,
  HTTP2_METHOD_GET,
  NGHTTP2_CANCEL
} = http2.constants

const kDefaults = Symbol('defaults')

const EOL = 10

function normalizeHeaders (headers) {
  const normalizeHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    normalizeHeaders[key.toLowerCase()] = value
  }
  return normalizeHeaders
}

class Client {
  constructor ({ prefixUrl, ...options }) {
    this[kDefaults] = {
      options: {
        prefixUrl,
        ...options
      }
    }
  }

  get defaults () {
    return this[kDefaults]
  }

  get baseUrl () {
    return new URL(this.defaults.options.prefixUrl)
  }

  getSession (options) {
    const origin = this.baseUrl.origin
    const { ca, rejectUnauthorized, key, cert, id } = this.defaults.options
    const defaultOptions = { ca, rejectUnauthorized, key, cert, id }
    return globalAgent.getSession(origin, Object.assign(defaultOptions, options))
  }

  getRequestHeaders (method, path, searchParams, headers = {}) {
    const url = this.baseUrl
    const [pathname, search = ''] = path.split(/\?/)
    if (pathname.startsWith('/')) {
      url.pathname = pathname
    } else {
      url.pathname = join(url.pathname, pathname)
    }
    if (!searchParams) {
      url.search = search
    } else if (searchParams instanceof URLSearchParams) {
      url.search = searchParams.toString()
    } else {
      url.search = new URLSearchParams(searchParams).toString()
    }
    const pseudoHeaders = {
      [HTTP2_HEADER_SCHEME]: url.protocol.replace(/:$/, ''),
      [HTTP2_HEADER_AUTHORITY]: url.host,
      [HTTP2_HEADER_METHOD]: method.toUpperCase(),
      [HTTP2_HEADER_PATH]: url.pathname + url.search
    }
    const defaultHeaders = this.defaults.options.headers
    return Object.assign(pseudoHeaders, defaultHeaders, normalizeHeaders(headers))
  }

  getResponseHeaders (stream, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        stream.close(NGHTTP2_CANCEL)
        reject(new Error(`Request timed out after ${timeout} milliseconds.`))
      }, timeout)
      stream.once('response', headers => {
        clearTimeout(timeoutId)
        resolve(headers)
      })
    })
  }

  async fetch (path, { method = HTTP2_METHOD_GET, searchParams, headers = {}, body, signal, ...options } = {}) {
    const session = this.getSession(options)
    headers = this.getRequestHeaders(method, path, searchParams, headers)
    const stream = await session.request(headers, { signal })
    if (body) {
      stream.write(body)
    }
    stream.end()
    headers = await this.getResponseHeaders(stream, 5000)
    return {
      headers,
      get statusCode () {
        return this.headers[HTTP2_HEADER_STATUS]
      },
      get ok () {
        return this.statusCode >= 200 && this.statusCode < 300
      },
      get redirected () {
        return this.statusCode >= 300 && this.statusCode < 400
      },
      get contentType () {
        return this.headers[HTTP2_HEADER_CONTENT_TYPE]
      },
      get contentLength () {
        return this.headers[HTTP2_HEADER_CONTENT_LENGTH]
      },
      get type () {
        return typeis.is(this.contentType, ['json', 'text'])
      },
      async error () {
        const statusCode = this.statusCode
        if (statusCode >= 400) {
          return createHttpError({
            statusCode,
            headers: this.headers,
            body: await this.body()
          })
        }
      },
      async body () {
        let data = Buffer.from([])
        for await (const chunk of stream) {
          data = Buffer.concat([data, chunk], data.length + chunk.length)
        }
        switch (this.type) {
          case 'text':
            return data.toString('utf8')
          case 'json':
            return JSON.parse(data)
          default:
            return data
        }
      },
      async * [Symbol.asyncIterator] () {
        let data = Buffer.from([])
        const transform = transformFactory(this.type)
        for await (const chunk of stream) {
          data = Buffer.concat([data, chunk], data.length + chunk.length)
          let index
          while ((index = data.indexOf(EOL)) !== -1) {
            yield transform(data.slice(0, index))
            data = data.slice(index + 1)
          }
        }
        if (data && data.length) {
          yield transform(data)
        }
      }
    }
  }

  async stream (path, options) {
    const response = await this.fetch(path, options)
    if (response.statusCode >= 400) {
      const error = await response.error()
      throw error
    }
    return response
  }

  async request (path, { headers = {}, body, json, ...options } = {}) {
    if (json) {
      body = JSON.stringify(json)
      headers[HTTP2_HEADER_CONTENT_TYPE] = 'application/json'
    }
    const response = await this.fetch(path, { headers, body, ...options })
    if (response.statusCode >= 400) {
      const error = await response.error()
      throw error
    }
    return response.body()
  }
}

Client.prototype.createHttpError = createHttpError
Client.prototype.isHttpError = isHttpError
Client.prototype.extend = extend

function extend (options) {
  return new Client(options)
}

function transformFactory (type) {
  switch (type) {
    case 'text':
      return data => data.toString('utf8')
    case 'json':
      return data => {
        try {
          return JSON.parse(data)
        } catch (err) {
          return err
        }
      }
    default:
      return data => data
  }
}

function createHttpError ({ statusCode, statusMessage = http.STATUS_CODES[statusCode], response, headers, body }) {
  const properties = { statusMessage }
  if (headers) {
    properties.headers = { ...headers }
  }
  if (body) {
    properties.body = body
  }
  if (response) {
    properties.response = response
  }
  const message = body && body.message
    ? body.message
    : `Response code ${statusCode} (${statusMessage})`
  return createError(statusCode, message, properties)
}

function isHttpError (err, expectedStatusCode) {
  if (!createError.isHttpError(err)) {
    return false
  }
  if (expectedStatusCode) {
    if (Array.isArray(expectedStatusCode)) {
      return expectedStatusCode.indexOf(err.statusCode) !== -1
    }
    return expectedStatusCode === err.statusCode
  }
  return true
}

module.exports = {
  Client,
  extend,
  createHttpError,
  isHttpError
}
