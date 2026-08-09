'use strict';

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Short, human-typeable linking code for the Telegram deep link.
// Uses an unambiguous alphabet (no 0/O, 1/I/L) since a person might
// have to type it by hand if the deep link doesn't auto-open.
const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newLinkCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, newToken, newLinkCode };
