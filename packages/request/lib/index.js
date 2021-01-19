//
// SPDX-FileCopyrightText: 2020 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const Client = require('./Client')
const { extend, createHttpError, isHttpError } = Client

module.exports = {
  Client,
  extend,
  createHttpError,
  isHttpError,
  HttpClient: Client
}
