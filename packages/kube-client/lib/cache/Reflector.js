//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const { format: fmt } = require('util')
const delay = require('delay')
const moment = require('moment')
const { globalLogger: logger } = require('@gardener-dashboard/logger')
const ListPager = require('./ListPager')
const {
  isExpiredError,
  isConnectionRefused,
  isTooLargeResourceVersionError,
  StatusError
} = require('../ApiErrors')

function randomize (duration) {
  return Math.round(duration * (Math.random() + 1.0))
}

function getTypeName (apiVersion, kind) {
  return `${apiVersion}, Kind=${kind}`
}

class BackoffManager {
  constructor ({ min = 800, max = 15 * 1000, resetDuration = 60 * 1000, factor = 1.5, jitter = 0.1 } = {}) {
    this.min = min
    this.max = max
    this.factor = factor
    this.jitter = jitter > 0 && jitter <= 1 ? jitter : 0
    this.resetDuration = resetDuration
    this.attempt = 0
    this.timeoutId = undefined
  }

  duration () {
    this.clearTimeout()
    this.timeoutId = setTimeout(() => this.reset(), this.resetDuration)
    const attempt = this.attempt
    this.attempt += 1
    if (attempt > Math.floor(Math.log(this.max / this.min) / Math.log(this.factor))) {
      return this.max
    }
    let duration = this.min * Math.pow(this.factor, attempt)
    if (this.jitter) {
      duration = Math.floor((1 + this.jitter * (2 * Math.random() - 1)) * duration)
    }
    return Math.min(Math.floor(duration), this.max)
  }

  reset () {
    this.attempt = 0
  }

  clearTimeout () {
    clearTimeout(this.timeoutId)
  }
}

class Reflector {
  constructor (listWatcher, store) {
    this.listWatcher = listWatcher
    this.store = store
    this.period = moment.duration(1, 'seconds')
    this.minWatchTimeout = moment.duration(5, 'minutes')
    this.isLastSyncResourceVersionUnavailable = false
    this.lastSyncResourceVersion = ''
    this.paginatedResult = false
    this.stopRequested = false
    this.backoffManager = new BackoffManager()
  }

  get apiVersion () {
    const { group, version } = this.listWatcher
    return group ? `${group}/${version}` : version
  }

  get kind () {
    const { names = {} } = this.listWatcher
    return names.kind
  }

  get expectedTypeName () {
    return getTypeName(this.apiVersion, this.kind)
  }

  get relistResourceVersion () {
    if (this.isLastSyncResourceVersionUnavailable) {
      // Since this reflector makes paginated list requests, and all paginated list requests skip the watch cache
      // if the lastSyncResourceVersion is expired, we set ResourceVersion="" and list again to re-establish reflector
      // to the latest available ResourceVersion, using a consistent read from etcd.
      return ''
    }
    if (this.lastSyncResourceVersion === '') {
      // For performance reasons, initial list performed by reflector uses "0" as resource version to allow it to
      // be served from the watch cache if it is enabled.
      return '0'
    }
    return this.lastSyncResourceVersion
  }

  stop () {
    this.stopRequested = true
    const agent = this.listWatcher.agent
    if (agent && typeof agent.destroy === 'function') {
      agent.destroy()
    }
    this.backoffManager.clearTimeout()
  }

  async run () {
    logger.info('Starting reflector %s', this.expectedTypeName)
    try {
      while (!this.stopRequested) {
        try {
          await this.listAndWatch()
        } catch (err) {
          logger.error('Failed to list and watch %s: %s', this.expectedTypeName, err)
        }
        if (this.stopRequested) {
          break
        }
        logger.info('Restarting reflector %s', this.expectedTypeName)
        await delay(this.backoffManager.duration())
      }
    } finally {
      logger.info('Stopped reflector %s', this.expectedTypeName)
    }
  }

  async listAndWatch () {
    const pager = ListPager.create(this.listWatcher)
    const options = {
      resourceVersion: this.relistResourceVersion
    }

    if (this.paginatedResult) {
      // We got a paginated result initially. Assume this resource and server honor
      // paging requests (i.e. watch cache is probably disabled) and leave the default
      // pager size set.
    } else if (options.resourceVersion !== '' && options.resourceVersion !== '0') {
      // User didn't explicitly request pagination.
      //
      // With ResourceVersion != "", we have a possibility to list from watch cache,
      // but we do that (for ResourceVersion != "0") only if Limit is unset.
      // To avoid thundering herd on etcd (e.g. on master upgrades), we explicitly
      // switch off pagination to force listing from watch cache (if enabled).
      // With the existing semantic of RV (result is at least as fresh as provided RV),
      // this is correct and doesn't lead to going back in time.
      //
      // We also don't turn off pagination for ResourceVersion="0", since watch cache
      // is ignoring Limit in that case anyway, and if watch cache is not enabled
      // we don't introduce regression.
      pager.pageSize = 0
    }

    this.store.setRefreshing()

    let list
    try {
      logger.debug('List %s with resourceVersion %s', this.expectedTypeName, options.resourceVersion)
      list = await pager.list(options)
    } catch (err) {
      if (isExpiredError(err) || isTooLargeResourceVersionError(err)) {
        this.isLastSyncResourceVersionUnavailable = true
        // Retry immediately if the resource version used to list is unavailable.
        // The pager already falls back to full list if paginated list calls fail due to an "Expired" error on
        // continuation pages, but the pager might not be enabled, the full list might fail because the
        // resource version it is listing at is expired or the cache may not yet be synced to the provided
        // resource version. So we need to fallback to resourceVersion="" in all to recover and ensure
        // the reflector makes forward progress.
        try {
          logger.debug('Falling back to full list %s', this.expectedTypeName)
          list = await pager.list({
            resourceVersion: this.relistResourceVersion
          })
        } catch (err) {
          logger.error('Failed to call full list %s: %s', this.expectedTypeName, err.message)
          return
        }
      }
      logger.error('Failed to call paginated list %s: %s', this.expectedTypeName, err.message)
      return
    }

    const {
      resourceVersion,
      paginated: paginatedResult
    } = list.metadata

    const lines = Array.isArray(list.items) ? list.items.length : 0
    logger.debug('List of %s successfully returned %d items (%s)', this.expectedTypeName, lines, paginatedResult ? 'paginated' : 'not paginated')

    // We check if the list was paginated and if so set the paginatedResult based on that.
    // However, we want to do that only for the initial list (which is the only case
    // when we set ResourceVersion="0"). The reasoning behind it is that later, in some
    // situations we may force listing directly from etcd (by setting ResourceVersion="")
    // which will return paginated result, even if watch cache is enabled. However, in
    // that case, we still want to prefer sending requests to watch cache if possible.
    //
    // Paginated result returned for request with ResourceVersion="0" mean that watch
    // cache is disabled and there are a lot of objects of a given type. In such case,
    // there is no need to prefer listing from watch cache.
    if (options.resourceVersion === '0' && paginatedResult) {
      this.paginatedResult = true
    }

    this.isLastSyncResourceVersionUnavailable = false
    this.store.replace(list.items)
    this.lastSyncResourceVersion = resourceVersion
    while (!this.stopRequested) {
      const options = {
        allowWatchBookmarks: true,
        timeoutSeconds: randomize(this.minWatchTimeout.asSeconds()),
        resourceVersion: this.lastSyncResourceVersion
      }

      if (this.stopRequested) {
        return
      }

      try {
        logger.debug('Watch %s with resourceVersion %s', this.expectedTypeName, options.resourceVersion)
        const asyncIterable = await this.listWatcher.watch(options)
        await this.watchHandler(asyncIterable)
      } catch (err) {
        if (isConnectionRefused(err)) {
          logger.info('Watch of %s connection refused with: %s', this.expectedTypeName, err.message)
          await delay(randomize(this.period.asMilliseconds()))
          continue
        }
        if (isExpiredError(err)) {
          // Don't set LastSyncResourceVersionUnavailable - LIST call with ResourceVersion=RV already
          // has a semantic that it returns data at least as fresh as provided RV.
          // So first try to LIST with setting RV to resource version of last observed object.
          logger.info('Watch of %s closed with: %s', this.expectedTypeName, err.message)
        } else {
          logger.warn('Watch of %s ended with: %s', this.expectedTypeName, err)
        }
        return
      }
    }
  }

  async watchHandler (asyncIterable) {
    const begin = moment()
    let count = 0
    for await (const data of asyncIterable) {
      count++
      if (data instanceof Error) {
        throw data
      }
      const { type, object } = data
      if (type === 'ERROR') {
        throw new StatusError(object)
      }
      const { apiVersion, kind, metadata: { resourceVersion } = {} } = object
      if (apiVersion !== this.apiVersion || kind !== this.kind) {
        const typeName = getTypeName(apiVersion, kind)
        logger.error('Expected %s, but watch event object had %s', this.expectedTypeName, typeName)
        continue
      }
      switch (type) {
        case 'ADDED':
          this.store.add(object)
          break
        case 'MODIFIED':
          this.store.update(object)
          break
        case 'DELETED':
          this.store.delete(object)
          break
        case 'BOOKMARK':
          break
        default:
          logger.error('Unable to understand event %s for watch %s', type, this.expectedTypeName)
      }
      if (resourceVersion) {
        this.lastSyncResourceVersion = resourceVersion
      } else {
        logger.error('Received event object without resource version for watch %s', this.expectedTypeName)
      }
    }
    const end = moment()
    const watchDuration = moment.duration(end.diff(begin))
    if (watchDuration.asMilliseconds() < 1000 && count === 0) {
      throw new Error(fmt('Very short watch %s - watch lasted less than a second and no items received', this.expectedTypeName))
    }
    logger.info('Watch %s closed - total %d items received within %s', this.expectedTypeName, count, watchDuration.humanize())
  }

  static create (listWatcher, store) {
    return new this(listWatcher, store)
  }
}

module.exports = Reflector
