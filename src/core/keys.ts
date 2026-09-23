/**
 * keys.ts — 持久化身份密钥
 *
 *  - swarmSeed: 32 字节 X25519 种子，喂给 hyperswarm 得到稳定路由身份(publicKey)
 *  - edPrivate/edPublic: Ed25519 密钥对，用于消息签名/验签 (P5)
 * 复用 bolloon p2p-secret.ts 的"同 role 跨重启同一身份"思路。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const BASE = process.env.HOME || process.env.USERPROFILE || '/tmp';
const DIR = path.join(BASE, '.bollfile');

export interface Keys {
  role: string;
  swarmSeed: string; // hex(32)
  edPrivate: string; // hex DER pkcs8
  edPublic: string; // hex DER spki
}

export function loadOrCreateKeys(role = 'default'): Keys {
  const file = path.join(DIR, `keys-${role}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Keys;
  } catch {
    const swarmSeed = crypto.randomBytes(32).toString('hex');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const edPrivate = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    const edPublic = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    const keys: Keys = { role, swarmSeed, edPrivate, edPublic };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys, null, 2));
    return keys;
  }
}

export function sign(edPrivateHex: string, data: Buffer): string {
  const pk = crypto.createPrivateKey({
    key: Buffer.from(edPrivateHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, data, pk).toString('base64');
}

export function verify(edPublicHex: string, data: Buffer, sigB64: string): boolean {
  try {
    const pk = crypto.createPublicKey({
      key: Buffer.from(edPublicHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, data, pk, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
