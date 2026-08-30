export interface Env {
  DB: D1Database;
  INTERNAL_JOB_SECRET: string;
  ADMIN_AUTH_SECRET: string;
  VAPID_MASTER_ENCRYPTION_KEY: string;
  SELF_BASE_URL?: string;
  VAPID_SUBJECT?: string;
  BATCH_SIZE: string;
  MAX_BODY_BYTES: string;
}

export interface SiteRow {
  id: number;
  site_key: string;
  name: string;
  domain: string;
  status: string;
  vapid_public_key: string;
  vapid_private_key_encrypted: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRow {
  id: number;
  site_id: number;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  status: string;
}

export interface CampaignRow {
  id: number;
  site_id: number | null;
  title: string;
  body: string;
  target_url: string | null;
  icon_url: string | null;
  badge_url: string | null;
  image_url: string | null;
  tag: string | null;
  status: string;
  total_targets: number;
  total_attempted: number;
  total_success: number;
  total_failed: number;
  cursor_subscription_id: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type PushResult =
  | "success"
  | "gone"
  | "rate_limited"
  | "temporary_error"
  | "bad_request";
