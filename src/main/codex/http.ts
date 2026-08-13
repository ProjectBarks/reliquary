/* eslint-disable @typescript-eslint/no-explicit-any */

import { request as httpsRequest } from 'https'
import { telemetry } from '../telemetry/Telemetry'

/**
 * The one way this process talks to spire-codex.com.
 *
 * Extracted from `CodexClient` so the compendium can share it rather than copy
 * it — and sharing matters here, not just tidiness. The API allows 15 requests
 * per minute *per endpoint*, and both consumers hit the same endpoints
 * (`/api/cards`, `/api/runs/metrics/cards`, `/api/runs/snapshot-status`). Two
 * private cooldown maps would each stay politely under the limit while the
 * process as a whole sailed past it, and the first thing we'd know about it is
 * the advisor going quiet mid-run. One map, one instance, one budget.
 */

export const CODEX_BASE = 'https://spire-codex.com'
const HTTP_TIMEOUT = 15000

/** Cooldown applied to an endpoint when the server didn't name a Retry-After. */
const DEFAULT_COOLDOWN_MS = 30_000

export class CodexHttp {
  /**
   * endpoint (path without query) -> earliest epoch ms to call it again, set
   * from a 429/503 so we honour the documented per-endpoint rate limit instead
   * of hammering.
   */
  private cooldownUntil = new Map<string, number>()

  constructor(
    private readonly base: string = CODEX_BASE,
    private readonly timeoutMs: number = HTTP_TIMEOUT
  ) {}

  get(path: string): Promise<any> {
    return this.json('GET', path)
  }

  post(path: string, body: unknown): Promise<any> {
    return this.json('POST', path, body)
  }

  /** True while `path`'s endpoint is backed off, so callers can skip the round trip. */
  cooling(path: string): boolean {
    const until = this.cooldownUntil.get(endpointOf(path))
    return !!until && Date.now() < until
  }

  json(method: string, path: string, body?: unknown): Promise<any> {
    const endpoint = endpointOf(path)
    const until = this.cooldownUntil.get(endpoint)
    if (until && Date.now() < until) {
      return Promise.reject(new Error(`rate-limited ${endpoint} (cooling down)`))
    }
    const payload = body != null ? JSON.stringify(body) : null
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        `${this.base}${path}`,
        {
          method,
          timeout: this.timeoutMs,
          headers: {
            accept: 'application/json',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {})
          }
        },
        (res) => {
          if (res.statusCode == null || res.statusCode < 200 || res.statusCode >= 300) {
            // Honor rate limiting: back this endpoint off until Retry-After (or 30s).
            let cooldownMs: number | null = null
            if (res.statusCode === 429 || res.statusCode === 503) {
              const ra = Number(res.headers['retry-after'])
              cooldownMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : DEFAULT_COOLDOWN_MS
              this.cooldownUntil.set(endpoint, Date.now() + cooldownMs)
            }
            // Codex outages/rate limits are the difference between "no numbers"
            // and "wrong numbers"; both look identical to the user.
            telemetry.issue('codex_http_error', res.statusCode === 429 ? 'warn' : 'error', {
              endpoint,
              status: res.statusCode,
              cooldown_ms: cooldownMs
            })
            res.resume()
            reject(new Error(`HTTP ${res.statusCode} ${path}`))
            return
          }
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(buf))
            } catch (err) {
              telemetry.issue('codex_bad_json', 'error', { endpoint, bytes: buf.length }, err)
              reject(err)
            }
          })
        }
      )
      req.on('timeout', () => {
        telemetry.issue('codex_timeout', 'warn', { endpoint, timeout_ms: this.timeoutMs })
        req.destroy(new Error(`timeout ${path}`))
      })
      req.on('error', (err) => {
        telemetry.issue('codex_request_error', 'error', { endpoint }, err)
        reject(err)
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}

function endpointOf(path: string): string {
  return path.split('?')[0]
}

/**
 * The process-wide client. Everything that calls spire-codex.com goes through
 * this instance so the rate-limit budget is shared rather than duplicated.
 */
export const codexHttp = new CodexHttp()
