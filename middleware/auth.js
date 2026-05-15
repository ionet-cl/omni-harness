/**
 * Auth — Middleware de autenticación para el bridge.
 *
 * Extrae y valida el token de API desde headers.
 * Compatible con formatos Anthropic (x-api-key) y OpenAI (Authorization: Bearer).
 */

/**
 * Extrae el token de autenticación de un request HTTP.
 * @param {IncomingMessage} req
 * @returns {string} Token o cadena vacía
 */
function requestAuthToken(req) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return req.headers["x-api-key"] || "";
}

/**
 * Valida que el token no esté vacío.
 * @param {string} token
 * @returns {boolean}
 */
function isValidToken(token) {
  return typeof token === "string" && token.length > 0;
}

module.exports = { requestAuthToken, isValidToken };
