#!/usr/bin/env node
'use strict'

// LazyCat serves this DSH app on an arbitrary box sub-domain, not loopback.
// DSH's `dsh-client-ui-settings` plugin selects Host settings persistence with
// `ctx.remote.$host.isLoopback ? "host" : "memory"`. On a LazyCat hostname the
// upstream capability flag is false, so Settings starts in browser-memory mode
// and the Models page fails with "settings are unavailable in this browser".
//
// Least-privilege repair: extend ONLY the settings persistence selector with an
// exact, HTTPS, canonical app-hostname match. We deliberately do NOT touch
// `ConnectionHandle.isLoopback` (an upstream "privileged surface" capability),
// so the open-config action and any future loopback-only features stay off.
//
// Fail-closed: a missing or malformed LAZYCAT_APP_DOMAIN aborts container start
// instead of silently degrading Settings to memory mode.

const fs = require('node:fs')

const MARKER_PREFIX = 'dsh-lazycat-settings-v2'
const target = process.env.DSH_SETTINGS_CLIENT_FILE ||
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js'

function parseCanonicalHostname(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === '') return null
  // The generated predicate must be an exact bare hostname literal: refuse a
  // scheme, path, query, fragment, credentials, whitespace or explicit port.
  if (/[/\\@?#\s]/.test(cleaned)) return null
  if (cleaned.includes(':')) return null
  const labels = cleaned.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  return cleaned
}

const appHost = parseCanonicalHostname(process.env.LAZYCAT_APP_DOMAIN)
if (appHost === null) {
  throw new Error(
    'patch-dsh-settings: LAZYCAT_APP_DOMAIN is missing or not a bare hostname; refusing to start with Settings in memory mode',
  )
}

if (!fs.existsSync(target)) {
  throw new Error(`patch-dsh-settings: DSH settings client bundle not found: ${target}`)
}

const expression =
  `const persistence = (ctx.remote.$host.isLoopback || (globalThis.location?.protocol === "https:" && globalThis.location?.hostname === ${JSON.stringify(appHost)})) ? "host" : "memory"; /* ${MARKER_PREFIX}:${appHost} */`

const original = fs.readFileSync(target, 'utf8')
const lines = original.split('\n')

let index = -1
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  if (line.includes('const persistence =') && line.includes('? "host" : "memory"')) {
    index = i
    break
  }
}

if (index === -1) {
  throw new Error(`patch-dsh-settings: persistence selector not found in ${target}`)
}

const indent = lines[index].match(/^\s*/)[0]
const desired = indent + expression

if (lines[index] === desired) {
  console.log(`patch-dsh-settings: already applied for ${appHost}`)
  process.exit(0)
}

lines[index] = desired
const patched = lines.join('\n')

const occurrences = patched.split(MARKER_PREFIX).length - 1
if (occurrences !== 1 || !patched.includes(`globalThis.location?.hostname === ${JSON.stringify(appHost)}`)) {
  throw new Error('patch-dsh-settings: post-write verification failed')
}

const temporary = `${target}.lzc-patch.tmp`
fs.writeFileSync(temporary, patched)
fs.renameSync(temporary, target)
console.log(`patch-dsh-settings: bound Settings Host persistence to ${appHost} in ${target}`)
