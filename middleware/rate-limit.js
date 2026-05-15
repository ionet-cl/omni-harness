/**
 * Rate Limit — Middleware de throttling para el bridge.
 *
 * Implementa token bucket algorithm para limitar requests.
 * Previene abusos del upstream por clientes ruidosos.
 */

const { randomUUID } = require("crypto");

/**
 * Token Bucket rate limiter.
 * Cada bucket tiene capacidad máxima y tasa de recarga.
 */
class TokenBucket {
  /**
   * @param {number} capacity - Máximo de tokens (burst)
   * @param {number} refillRate - Tokens por segundo
   */
  constructor(capacity = 60, refillRate = 10) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Intenta consumir un token.
   * @returns {boolean} true si hay token disponible, false si rate-limited
   */
  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /**
   * @returns {{ capacity: number, tokens: number, refillRate: number }}
   */
  status() {
    this._refill();
    return {
      capacity: this.capacity,
      tokens: Math.round(this.tokens * 100) / 100,
      refillRate: this.refillRate,
    };
  }
}

// Bucket por defecto (global)
const defaultBucket = new TokenBucket(60, 10);

/**
 * Crea un handler rate-limited.
 * @param {function} handler
 * @param {TokenBucket} [bucket] - Opcional, usa default si no se especifica
 * @returns {function}
 */
function withRateLimit(handler, bucket = defaultBucket) {
  return (req, res, ...args) => {
    if (!bucket.tryConsume()) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "rate_limit_exceeded",
        message: "Too many requests. Try again later.",
        retry_after_seconds: 1,
      }));
      return;
    }
    return handler(req, res, ...args);
  };
}

module.exports = { TokenBucket, withRateLimit, defaultBucket };
