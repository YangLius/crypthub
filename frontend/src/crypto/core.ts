/**
 * 加密原语（与 backend/app/mirror_crypto.py 严格对齐 —— docs/03-加密流程伪代码.md）。
 * 算法锁定：Argon2id(m=64MiB,t=3,p=1) / HKDF-SHA256 / AES-256-GCM / X25519+HKDF+AES-GCM(ECIES)。
 */
import { argon2id } from 'hash-wasm'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { hmac } from '@noble/hashes/hmac.js'
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'

// ---------- 常量（与镜像一致，勿改） ----------
export const ARGON2 = { m: 64 * 1024, t: 3, p: 1, len: 32 } as const
export const KEY_LEN = 32
export const NONCE_LEN = 12

export const AAD = {
  localCheck: 'kb:local-check',
  userPriv: 'kb:user-priv:',           // + userId
  userPrivRk: 'kb:user-priv-rk',
  entry: 'kb:secret:',                 // + secretId
  dek: 'kb:dek:',                      // + secretId + ':' + userId
  orgDek: 'kb:org-dek:',               // + secretId
  orgDelegate: 'kb:org-delegate:',     // + userId
  orgOffline: 'kb:org-offline',
} as const
export const INFO_SEAL = 'kb:seal:'

// ---------- 编码 ----------
const te = new TextEncoder()
const td = new TextDecoder()

export function b64e(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function b64d(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function utf8(s: string): Uint8Array { return te.encode(s) }
export function fromUtf8(b: Uint8Array): string { return td.decode(b) }

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** 分组格式化恢复码，便于抄写：XXXX-XXXX-... */
export function formatRecoveryCode(b32: string): string {
  return b32.replace(/(.{4})/g, '$1-').replace(/-$/, '')
}

// ---------- KDF ----------
export function argon2idKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({
    password, salt,
    parallelism: ARGON2.p, iterations: ARGON2.t,
    memorySize: ARGON2.m, hashLength: ARGON2.len,
    outputType: 'binary',
  }) as Promise<Uint8Array>
}

function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, len = KEY_LEN): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8(info), len)
}

export async function deriveAuthProofKey(mp: string, saltAuth: Uint8Array): Promise<string> {
  const root = await argon2idKey(mp, saltAuth)
  const authKey = hkdfSha256(root, utf8('kb:auth'), 'auth')
  return hex(hkdfSha256(authKey, utf8('kb:ap'), 'ap'))
}

export async function deriveEncKey(mp: string, saltEnc: Uint8Array): Promise<Uint8Array> {
  const root = await argon2idKey(mp, saltEnc)
  return hkdfSha256(root, utf8('kb:enc'), 'enc')
}

export async function deriveRkKey(rk: string, saltRk: Uint8Array): Promise<Uint8Array> {
  return argon2idKey(rk, saltRk)
}

// ---------- AEAD ----------
export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const nonce = randomBytes(NONCE_LEN)
  const sealed = gcm(key, nonce, utf8(aad)).encrypt(plaintext)
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce); out.set(sealed, nonce.length)
  return out
}

export function aeadOpen(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  if (blob.length < NONCE_LEN + 16) throw new Error('密文过短')
  const nonce = blob.slice(0, NONCE_LEN)
  return gcm(key, nonce, utf8(aad)).decrypt(blob.slice(NONCE_LEN))
}

// ---------- ECIES（X25519 信封） ----------
export function x25519Keygen(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomPrivateKey()
  return { priv, pub: x25519.getPublicKey(priv) }
}

export function eciesSeal(recipientPub: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const eph = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(eph)
  const ss = x25519.getSharedSecret(eph, recipientPub)
  const key = hkdfSha256(ss, concat(ephPub, recipientPub), INFO_SEAL + aad)
  const nonce = randomBytes(NONCE_LEN)
  const body = gcm(key, nonce, utf8(aad)).encrypt(plaintext)
  const out = new Uint8Array(32 + NONCE_LEN + body.length)
  out.set(ephPub); out.set(nonce, 32); out.set(body, 32 + NONCE_LEN)
  return out
}

export function eciesOpen(myPriv: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  if (blob.length < 32 + NONCE_LEN + 16) throw new Error('信封过短')
  const ephPub = blob.slice(0, 32)
  const nonce = blob.slice(32, 32 + NONCE_LEN)
  const myPub = x25519.getPublicKey(myPriv)
  const ss = x25519.getSharedSecret(myPriv, ephPub)
  const key = hkdfSha256(ss, concat(ephPub, myPub), INFO_SEAL + aad)
  return gcm(key, nonce, utf8(aad)).decrypt(blob.slice(32 + NONCE_LEN))
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

export function hmacHex(key: Uint8Array, msg: string): string {
  return hex(hmac(sha256, key, utf8(msg)))
}
