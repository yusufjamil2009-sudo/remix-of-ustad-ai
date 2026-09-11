/**
 * Password hashing for the permanent Guest ID identity layer.
 *
 * scrypt (memory-hard, in Node core) is used because this project has no auth
 * provider and no native-module build step, so a battle-tested KDF that ships
 * with Node is the safest production choice while remaining close in strength
 * to Argon2id. If an Argon2 provider is ever added, only this module changes.
 *
 * Guarantees (spec §14):
 *   • a random 16-byte salt per password — identical passwords never collide
 *   • the algorithm + parameters are stored WITH the hash, so parameters can be
 *     upgraded later and old hashes still verify
 *   • plaintext is never stored, logged or returned
 *   • verification is constant-time and never throws on corrupt input
 *
 * There is no database import here on purpose: the KDF is pure and therefore
 * directly unit-tested (see tests/identity.test.ts).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Memory-hard parameters: ~32 MB of work per hash, deliberately slow to brute-force. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const ALGO = "scrypt";

/**
 * scrypt requires `128 * N * r` bytes and Node's default maxmem is 32 MB — which
 * these parameters sit exactly on — so the ceiling is raised explicitly.
 * Without this, hashing throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS at runtime.
 */
function scryptMaxmem(n: number, r: number): number {
  return Math.max(64 * 1024 * 1024, 256 * n * r);
}

/** `scrypt$N$r$p$saltHex$hashHex` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R),
  });
  return [
    ALGO,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/** Constant-time verification. Returns false (never throws) for corrupt input. */
export async function verifyPassword(stored: unknown, password: unknown): Promise<boolean> {
  try {
    const parts = String(stored ?? "").split("$");
    if (parts.length !== 6) return false;
    const [algo, n, r, p, saltHex, hashHex] = parts;
    if (algo !== ALGO || !saltHex || !hashHex) return false;
    const nNum = Number(n);
    const rNum = Number(r);
    const pNum = Number(p);
    if (!Number.isInteger(nNum) || !Number.isInteger(rNum) || !Number.isInteger(pNum)) {
      return false;
    }
    // Bounded so a corrupted/tampered stored hash cannot exhaust memory.
    if (nNum < 1024 || nNum > 1 << 21 || rNum < 1 || rNum > 32 || pNum < 1 || pNum > 16) {
      return false;
    }
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const derived = await scrypt(
      String(password ?? ""),
      Buffer.from(saltHex, "hex"),
      expected.length,
      {
        N: nNum,
        r: rNum,
        p: pNum,
        maxmem: scryptMaxmem(nNum, rNum),
      },
    );
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}
