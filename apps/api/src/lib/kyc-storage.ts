import { readFileSync } from 'node:fs';

/**
 * Where KYC photos live. With Firebase configured they go to a private Storage bucket and
 * Postgres keeps only the path; without it (dev, tests) they stay in kyc_files.data as before.
 */
export interface KycBlobStore {
  put(path: string, data: Buffer, mime: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  /** Best effort; a missing object is not an error. */
  delete(path: string): Promise<void>;
}

export interface FirebaseStorageConfig {
  bucket: string;
  /** Service account JSON (Firebase console > Configurações > Contas de serviço). Unset: Application Default Credentials. */
  credentialsFile?: string | undefined;
}

export async function createFirebaseKycStore(cfg: FirebaseStorageConfig): Promise<KycBlobStore> {
  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');
  const credential = cfg.credentialsFile
    ? cert(JSON.parse(readFileSync(cfg.credentialsFile, 'utf8')) as Record<string, string>)
    : applicationDefault();
  const app = initializeApp({ credential, storageBucket: cfg.bucket }, 'kyc');
  const bucket = getStorage(app).bucket();

  return {
    async put(path, data, mime) {
      // Private: no public URL, no download token; only the API (admin SDK) reads it back.
      await bucket.file(path).save(data, { contentType: mime, resumable: false, metadata: { cacheControl: 'private, no-store' } });
    },
    async get(path) {
      const [buf] = await bucket.file(path).download();
      return buf;
    },
    async delete(path) {
      await bucket.file(path).delete({ ignoreNotFound: true });
    },
  };
}

/** In-memory store for tests. */
export function createMemoryKycStore(): KycBlobStore & { objects: Map<string, { data: Buffer; mime: string }> } {
  const objects = new Map<string, { data: Buffer; mime: string }>();
  return {
    objects,
    async put(path, data, mime) {
      objects.set(path, { data: Buffer.from(data), mime });
    },
    async get(path) {
      const o = objects.get(path);
      if (!o) throw new Error(`no object at ${path}`);
      return o.data;
    },
    async delete(path) {
      objects.delete(path);
    },
  };
}
