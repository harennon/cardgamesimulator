import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pluggable storage abstraction for feedback attachments (architecture-principles §7).
 * The backend service_role key bypasses Storage RLS; the bucket is private.
 */
export interface AttachmentStorage {
  upload(key: string, data: Buffer, mimeType: string): Promise<void>;
  createSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Remove an exact key. No-op if the object is absent. */
  remove(key: string): Promise<void>;
  /** Remove all objects whose key starts with `prefix/`. Idempotent. */
  removeByPrefix(prefix: string): Promise<void>;
}

const BUCKET = "feedback-attachments";

/**
 * Supabase Storage implementation. Takes a lazy getter so the singleton is
 * constructed at module load before SupabaseDB.initialize() creates the client.
 */
export class SupabaseAttachmentStorage implements AttachmentStorage {
  constructor(private readonly getClient: () => SupabaseClient) {}

  async upload(key: string, data: Buffer, mimeType: string): Promise<void> {
    const { error } = await this.getClient()
      .storage.from(BUCKET)
      .upload(key, data, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async createSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { data, error } = await this.getClient()
      .storage.from(BUCKET)
      .createSignedUrl(key, ttlSeconds);
    if (error || !data?.signedUrl)
      throw new Error(
        `Storage createSignedUrl failed: ${error?.message ?? "no url"}`,
      );
    return data.signedUrl;
  }

  async remove(key: string): Promise<void> {
    const { error } = await this.getClient().storage.from(BUCKET).remove([key]);
    if (error) throw new Error(`Storage remove failed: ${error.message}`);
  }

  async removeByPrefix(prefix: string): Promise<void> {
    const { data, error } = await this.getClient()
      .storage.from(BUCKET)
      .list(prefix);
    if (error) throw new Error(`Storage list failed: ${error.message}`);
    const objects = data ?? [];
    if (objects.length === 0) return;
    const keys = objects.map((o) => `${prefix}/${o.name}`);
    const { error: removeErr } = await this.getClient()
      .storage.from(BUCKET)
      .remove(keys);
    if (removeErr)
      throw new Error(`Storage removeByPrefix failed: ${removeErr.message}`);
  }
}
