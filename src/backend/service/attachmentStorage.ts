import { SupabaseClient } from "@supabase/supabase-js";

export interface AttachmentStorage {
  upload(key: string, data: Buffer, mimeType: string): Promise<void>;
  createSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Delete a single object by its exact key (no-op if already absent). */
  remove(key: string): Promise<void>;
  /** Delete all objects under the given prefix (idempotent — no-op if absent). */
  removeByPrefix(prefix: string): Promise<void>;
}

const BUCKET = "feedback-attachments";

export class SupabaseAttachmentStorage implements AttachmentStorage {
  /**
   * Accepts a lazy client getter so the Supabase client can be accessed only
   * after SupabaseDB.initialize() has been called (the singleton is constructed
   * at module-load time, before initialize runs).
   */
  constructor(private readonly getClient: () => SupabaseClient) {}

  private get client(): SupabaseClient {
    return this.getClient();
  }

  async upload(key: string, data: Buffer, mimeType: string): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(key, data, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async createSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(key, ttlSeconds);
    if (error || !data?.signedUrl) {
      throw new Error(
        `Storage createSignedUrl failed: ${error?.message ?? "no URL returned"}`,
      );
    }
    return data.signedUrl;
  }

  async remove(key: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).remove([key]);
    if (error) throw new Error(`Storage remove failed: ${error.message}`);
  }

  async removeByPrefix(prefix: string): Promise<void> {
    // List all objects under the prefix and delete them.
    const { data: listed, error: listError } = await this.client.storage
      .from(BUCKET)
      .list(prefix, { limit: 1000 });
    if (listError) throw new Error(`Storage list failed: ${listError.message}`);
    if (!listed || listed.length === 0) return;

    const paths = listed.map((obj) => `${prefix}/${obj.name}`);
    const { error: removeError } = await this.client.storage
      .from(BUCKET)
      .remove(paths);
    if (removeError)
      throw new Error(`Storage remove failed: ${removeError.message}`);
  }
}
