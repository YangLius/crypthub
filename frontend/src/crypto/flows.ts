/**
 * 加密流程（对应 docs/03-加密流程伪代码.md 第 1–8 节）。
 * 约束：encKey / 用户私钥 / DEK / 条目明文只存在于本调用链的内存中。
 */
import {
  AAD,
  aeadOpen,
  aeadSeal,
  b64d,
  b64e,
  base32,
  deriveAuthProofKey,
  deriveEncKey,
  deriveRkKey,
  eciesOpen,
  eciesSeal,
  formatRecoveryCode,
  fromUtf8,
  hex,
  randomBytes,
  utf8,
  x25519Keygen,
} from "./core";

export type Keypair = { priv: Uint8Array; pub: Uint8Array };

export interface SetupMaterial {
  saltAuthB64: string;
  saltEncB64: string;
  authVerifierHex: string;
  localCheckCtB64: string;
  publicKeyB64: string;
  privWrappedB64: string;
  rkSaltB64: string;
  privRkWrappedB64: string;
  recoveryCode: string; // 展示一次
  org?: {
    publicKeyB64: string;
    offlineSaltHex: string; // 与 offline-package 端点一致（hex）
    orgPrivOfflineWrappedB64: string;
    delegateSealedB64: string;
    offlineCode: string; // 展示一次（首管理员）
  };
}

/** 生成注册材料（不含任何发往服务端的明文密钥）。 */
export async function buildSetupMaterial(
  mp: string,
  userId: string,
  withOrg: boolean,
): Promise<SetupMaterial> {
  const saltAuth = randomBytes(16);
  const saltEnc = randomBytes(16);
  const authVerifierHex = await deriveAuthProofKey(mp, saltAuth);
  const encKey = await deriveEncKey(mp, saltEnc);
  const localCheckCtB64 = b64e(
    aeadSeal(encKey, utf8("vault-check-v1"), AAD.localCheck),
  );
  const kp = x25519Keygen();
  const privWrappedB64 = b64e(aeadSeal(encKey, kp.priv, AAD.userPriv + userId));
  const rkSalt = randomBytes(16);
  const rk = formatRecoveryCode(base32(randomBytes(32)));
  const rkKey = await deriveRkKey(rk, rkSalt);
  const privRkWrappedB64 = b64e(aeadSeal(rkKey, kp.priv, AAD.userPrivRk));

  const mat: SetupMaterial = {
    saltAuthB64: b64e(saltAuth),
    saltEncB64: b64e(saltEnc),
    authVerifierHex,
    localCheckCtB64,
    publicKeyB64: b64e(kp.pub),
    privWrappedB64,
    rkSaltB64: b64e(rkSalt),
    privRkWrappedB64,
    recoveryCode: rk,
  };

  if (withOrg) {
    const org = x25519Keygen();
    const offlineSalt = randomBytes(16);
    const offlineCode = formatRecoveryCode(base32(randomBytes(32)));
    const orgOfflineKey = await deriveRkKey(offlineCode, offlineSalt);
    mat.org = {
      publicKeyB64: b64e(org.pub),
      offlineSaltHex: hex(offlineSalt),
      orgPrivOfflineWrappedB64: b64e(
        aeadSeal(orgOfflineKey, org.priv, AAD.orgOffline),
      ),
      delegateSealedB64: b64e(
        eciesSeal(kp.pub, org.priv, AAD.orgDelegate + userId),
      ),
      offlineCode,
    };
  }
  return mat;
}

export interface UnlockedVault {
  encKey: Uint8Array;
  priv: Uint8Array;
}

/** 解锁：派生 encKey → 试解本地校验串 → 解出用户私钥。成功后内存态持有两者。 */
export async function unlockVault(
  mp: string,
  me: {
    user_id: string;
    salt_enc: string;
    local_check_ct: string;
    priv_wrapped: string;
  },
): Promise<UnlockedVault> {
  const encKey = await deriveEncKey(mp, b64d(me.salt_enc));
  const plain = aeadOpen(encKey, b64d(me.local_check_ct), AAD.localCheck);
  if (fromUtf8(plain) !== "vault-check-v1") throw new Error("解锁校验失败");
  const priv = aeadOpen(
    encKey,
    b64d(me.priv_wrapped),
    AAD.userPriv + me.user_id,
  );
  return { encKey, priv };
}

/** 登录证明（不触发解锁）。 */
export const loginProof = deriveAuthProofKey;

// ---------- 条目 ----------

export interface SecretContent {
  /** 条目类型模板标识（见 secrets/templates.ts），旧数据无此字段。 */
  type?: string;
  username?: string;
  password?: string;
  url?: string;
  tokens?: string;
  notes?: string;
  custom?: { k: string; v: string }[];
}

export function newDek(): Uint8Array {
  return randomBytes(32);
}

export function encryptContent(
  dek: Uint8Array,
  content: SecretContent,
  secretId: string,
): string {
  return b64e(
    aeadSeal(dek, utf8(JSON.stringify(content)), AAD.entry + secretId),
  );
}

export function decryptContent(
  dek: Uint8Array,
  contentCtB64: string,
  secretId: string,
): SecretContent {
  let plain: Uint8Array;
  try {
    plain = aeadOpen(dek, b64d(contentCtB64), AAD.entry + secretId);
  } catch {
    throw new Error(`解密失败（密钥不匹配或密文被篡改）：${secretId}`);
  }
  try {
    return JSON.parse(fromUtf8(plain)) as SecretContent;
  } catch {
    throw new Error("解密成功但内容不是有效 JSON（版本不匹配？）");
  }
}

/** 为目标用户公钥包装 DEK（共享 / 创建时的 owner 授权）。 */
export function sealDekForUser(
  recipientPubB64: string,
  dek: Uint8Array,
  secretId: string,
  userId: string,
): string {
  return b64e(
    eciesSeal(b64d(recipientPubB64), dek, AAD.dek + secretId + ":" + userId),
  );
}

export function sealDekForOrg(
  orgPubB64: string,
  dek: Uint8Array,
  secretId: string,
): string {
  return b64e(eciesSeal(b64d(orgPubB64), dek, AAD.orgDek + secretId));
}

/** reveal 后的解链：私钥 → 打开自己的 wrapped DEK → 解内容。 */
export function openSecret(
  vault: UnlockedVault,
  wrappedDekB64: string,
  contentCtB64: string,
  secretId: string,
  myUserId: string,
): SecretContent {
  const dek = eciesOpen(
    vault.priv,
    b64d(wrappedDekB64),
    AAD.dek + secretId + ":" + myUserId,
  );
  return decryptContent(dek, contentCtB64, secretId);
}

// ---------- 恢复 ----------

/** 组织恢复：用管理员私钥打开组织私钥委托副本。 */
export function openOrgDelegate(
  vault: UnlockedVault,
  sealedB64: string,
  adminUserId: string,
): Uint8Array {
  return eciesOpen(vault.priv, b64d(sealedB64), AAD.orgDelegate + adminUserId);
}

/** 组织路径解条目 DEK。 */
export function openOrgWrappedDek(
  orgPriv: Uint8Array,
  sealedB64: string,
  secretId: string,
): Uint8Array {
  return eciesOpen(orgPriv, b64d(sealedB64), AAD.orgDek + secretId);
}

/** 个人恢复码解回用户私钥（新设备找回）。 */
export async function recoverPrivWithRk(
  rk: string,
  rkSaltB64: string,
  privRkWrappedB64: string,
): Promise<Uint8Array> {
  const rkKey = await deriveRkKey(rk, b64d(rkSaltB64));
  return aeadOpen(rkKey, b64d(privRkWrappedB64), AAD.userPrivRk);
}

// ---------- 轮换 ----------

export interface RotationPlan {
  contentCt: string;
  dekWrappedOrg: string;
  wrappedDeks: Record<string, string>; // 全量重包（含 owner）
  oldContentCt: string;
  oldWrappedDeks: Record<string, string>; // 归档用（来自当前 grants）
}

/**
 * 轮换计划（设计 4.4）：新 DEK + 新密文 + 对 owner/全部 grantee/组织重新包装。
 * @param pubkeyMap userId → 公钥 b64（来自 /secrets/share-targets；owner 也必须在内）
 * @param oldContentCt 当前密文（reveal 返回），归档用
 */
export function buildRotationPlan(opts: {
  secretId: string;
  myUserId: string;
  content: SecretContent;
  orgPubB64: string;
  pubkeyMap: Record<string, string>;
  grants: { user_id: string; wrapped_dek: string }[];
  oldContentCt: string;
}): RotationPlan {
  const {
    secretId,
    myUserId,
    content,
    orgPubB64,
    pubkeyMap,
    grants,
    oldContentCt,
  } = opts;
  const dek = newDek();
  const targets = [...grants.map((g) => g.user_id)];
  if (!targets.includes(myUserId)) targets.push(myUserId);
  const wrappedDeks: Record<string, string> = {};
  for (const uid of targets) {
    const pub = pubkeyMap[uid];
    if (!pub) throw new Error(`缺少成员 ${uid} 的公钥（先取 share-targets）`);
    wrappedDeks[uid] = sealDekForUser(pub, dek, secretId, uid);
  }
  const oldWrappedDeks: Record<string, string> = {};
  for (const g of grants) oldWrappedDeks[g.user_id] = g.wrapped_dek;
  return {
    contentCt: encryptContent(dek, content, secretId),
    dekWrappedOrg: sealDekForOrg(orgPubB64, dek, secretId),
    wrappedDeks,
    oldContentCt,
    oldWrappedDeks,
  };
}
