//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const EventEmitter = require('events')
const http2 = require('http2')
const net = require('net')
const crypto = require('crypto')
const { promisify } = require('util')
const QuickLRU = require('quick-lru')
const { globalLogger: logger } = require('@gardener-dashboard/logger')
const Semaphore = require('./Semaphore')

const kSemaphore = Symbol('semaphore')
const kRequest = Symbol('request')
const kSid = Symbol('sid')
const kTimestamp = Symbol('timestamp')
const kConnected = Symbol('connected')
const kTimeoutId = Symbol('timeoutId')
const kIntervalId = Symbol('intervalId')

const { NGHTTP2_CANCEL } = http2.constants

class Agent extends EventEmitter {
  constructor (options = {}) {
    super()
    const {
      maxCachedTlsSessions = 100,
      timeout = 60000,
      connectTimeout = 5000,
      gracePeriod = 5000,
      maxOutstandingPings = 2,
      pingInterval = 20000
    } = options
    this.timeout = timeout
    this.connectTimeout = connectTimeout
    this.gracePeriod = gracePeriod
    this.maxOutstandingPings = maxOutstandingPings
    this.pingInterval = pingInterval
    this.tlsSessionCache = new QuickLRU({
      maxSize: maxCachedTlsSessions
    })
    this.sessionMap = new Map()
  }

  findSession (sid) {
    const iterable = this.sessionMap.get(sid)
    if (iterable) {
      return Array.from(iterable)
        // consider free sessions only
        .filter(({ [kSemaphore]: semaphore }) => {
          return semaphore.value > 0
        })
        // session with the highest load first
        .sort(({ [kSemaphore]: a }, { [kSemaphore]: b }) => {
          return a.value - b.value
        })
        .shift()
    }
  }

  getSession (authority, { settings, ...options } = {}) {
    authority = normalizeAuthority(authority)
    options = Object.assign({
      peerMaxConcurrentStreams: 100,
      settings: Object.assign({
        enablePush: false
      }, settings),
      connectTimeout: this.connectTimeout,
      timeout: this.timeout,
      maxOutstandingPings: this.maxOutstandingPings,
      pingInterval: this.pingInterval
    }, options)
    const sid = getSessionId(authority, options)
    let session = this.findSession(sid)
    if (!session) {
      session = this.constructor.createSession(authority, options)
      session[kSid] = sid
      this.replaceSessionRequest(session, options)
      this.addSessionListeners(session, options)
      this.addSession(session)
    }
    return session
  }

  addSession (session) {
    const sid = session[kSid]
    let sessionSet
    if (this.sessionMap.has(sid)) {
      sessionSet = this.sessionMap.get(sid)
      sessionSet.add(session)
    } else {
      sessionSet = new Set([session])
      this.sessionMap.set(sid, sessionSet)
    }
    const size = sessionSet.size
    logger.debug('Agent ---> session added   %s (%d)', sid, size)
  }

  deleteSession (session) {
    const sid = session[kSid]
    if (this.sessionMap.has(sid)) {
      const sessionSet = this.sessionMap.get(sid)
      const duration = Date.now() - session[kTimestamp]
      const removeSession = () => {
        if (sessionSet.delete(session)) {
          const size = sessionSet.size
          logger.debug('Agent ---> session deleted %s (%d)', sid, size)
          if (size === 0) {
            this.sessionMap.delete(sid)
          }
        }
      }
      // Wait at least 100 milliseconds before trying to create a new session
      if (duration > 100) {
        removeSession()
      } else {
        setTimeout(removeSession, 100 - duration)
      }
    }
  }

  clearSessionTimers (session) {
    if (session[kTimeoutId]) {
      clearTimeout(session[kTimeoutId])
      session[kTimeoutId] = undefined
    }
    if (session[kIntervalId]) {
      clearInterval(session[kIntervalId])
      session[kIntervalId] = undefined
    }
  }

  replaceSessionRequest (session, options = {}) {
    const {
      timeout = this.timeout
    } = options
    const semaphore = session[kSemaphore]
    session[kRequest] = session.request
    session.request = async function request (headers, options) {
      await session[kConnected]
      clearTimeout(session[kTimeoutId])
      const release = await semaphore.acquire()
      const stream = session[kRequest](headers, options)
      stream.once('error', err => {
        logger.error('Request -> stream error: %s', err.message)
      })
      stream.once('close', () => {
        release()
        if (semaphore.value >= session.remoteSettings.maxConcurrentStreams) {
          session[kTimeoutId] = setTimeout(() => session.close(), timeout)
        }
      })
      return stream
    }
  }

  setSessionHeartbeat (session, pingInterval = this.pingInterval) {
    const ping = promisify(session.ping).bind(session)
    let canceled = false
    const cancel = err => {
      this.clearSessionTimers(session)
      this.deleteSession(session)
      session.destroy(err, NGHTTP2_CANCEL)
    }
    session[kIntervalId] = setInterval(async () => {
      try {
        const duration = await ping()
        logger.debug('Session -> ping %d ms', Math.round(duration))
      } catch (err) {
        if (!canceled) {
          logger.error('Session -> canceled: %s', err.message)
          canceled = true
          cancel(err)
        }
      }
    }, pingInterval)
  }

  setSessionTimeout (session, timeout = this.timeout) {
    session.setTimeout(timeout, () => {
      logger.info('Session -> timeout')
      this.clearSessionTimers(session)
      this.deleteSession(session)
      session.destroy()
    })
  }

  addSessionListeners (session, options = {}) {
    const {
      connectTimeout = this.connectTimeout,
      timeout = this.timeout,
      pingInterval = this.pingInterval
    } = options
    const sid = session[kSid]
    const semaphore = session[kSemaphore]
    session.socket.on('session', tlsSession => {
      this.tlsSessionCache.set(sid, tlsSession)
    })
    const setMaxConcurrency = () => {
      semaphore.maxConcurrency = session.remoteSettings.maxConcurrentStreams
    }
    const deleteTlsSession = () => {
      this.tlsSessionCache.delete(sid)
    }
    const destroySession = () => {
      this.clearSessionTimers(session)
      this.deleteSession(session)
      session.destroy()
    }
    session[kConnected] = new Promise((resolve, reject) => {
      let settled = false
      const settle = err => {
        if (!settled) {
          clearTimeout(timeoutId)
          settled = true
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
      }
      const timeoutId = setTimeout(() => {
        const err = new Error('Session connect timed out')
        err.code = 'ETIMEDOUT'
        destroySession(err)
        settle(err)
      }, connectTimeout)
      session.on('error', err => {
        logger.error('Session -> error: %s', err.message)
        deleteTlsSession()
        destroySession(err)
        settle(err)
      })
      session.once('connect', () => {
        logger.debug('Session -> connected')
        setMaxConcurrency()
        session.once('remoteSettings', () => {
          setMaxConcurrency()
        })
        session.once('close', () => {
          logger.info('Session -> closed after %d ms', Date.now() - session[kTimestamp])
          this.clearSessionTimers(session)
          this.deleteSession(session)
        })
        if (pingInterval) {
          this.setSessionHeartbeat(session, pingInterval)
        } else if (timeout) {
          this.setSessionTimeout(session, timeout)
        }
        settle()
      })
    })
  }

  static createSession (authority, { peerMaxConcurrentStreams = 100, ...options } = {}) {
    const { origin, hostname } = authority
    const session = http2.connect(origin, {
      peerMaxConcurrentStreams,
      servername: !net.isIP(hostname) ? hostname : '',
      ...options
    })
    session[kTimestamp] = Date.now()
    session[kSemaphore] = new Semaphore(peerMaxConcurrentStreams)
    return session
  }
}

function normalizeAuthority (authority) {
  if (typeof authority === 'string') {
    authority = new URL(authority)
  }
  if (!(authority instanceof URL)) {
    throw new TypeError('The "authority" argument must be of type string or an instance of URL')
  }
  return authority
}

function normalizeObject (object) {
  const normalizedObject = {}
  for (const key of Object.keys(object).sort()) {
    const value = object[key]
    switch (typeof value) {
      case 'string':
      case 'number':
      case 'boolean':
        normalizedObject[key] = value
        break
      case 'object':
        if (value) {
          normalizedObject[key] = normalizeObject(value)
        }
        break
      case 'undefined':
        break
    }
  }
  return normalizedObject
}

function createObjectHash (object) {
  return crypto
    .createHash('md5')
    .update(JSON.stringify(normalizeObject(object)))
    .digest('hex')
}

function getSessionId (authority, { id, ...options } = {}) {
  const { origin } = authority
  let pathname = '/' + createObjectHash(options)
  if (id) {
    pathname += '/' + id
  }
  return origin + pathname
}

module.exports = {
  Agent,
  globalAgent: new Agent()
}
