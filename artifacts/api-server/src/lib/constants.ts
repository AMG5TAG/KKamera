export const SUBSCRIPTION_STATUS = {
  NONE: "none",
  TRIAL: "trial",
  ACTIVE: "active",
  EXPIRED: "expired",
  PAST_DUE: "past_due",
  CANCELLED: "cancelled",
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const UPLOAD_STATUS = {
  PENDING: "pending",
  QUEUED: "queued",
  UPLOADING: "uploading",
  DONE: "done",
  FAILED: "failed",
  PARTIAL: "partial",
} as const;

export const CLOUD_PROVIDER = {
  FTP: "ftp",
  WEBDAV: "webdav",
  GOOGLEDRIVE: "googledrive",
  ONEDRIVE: "onedrive",
  DROPBOX: "dropbox",
} as const;

export const REFERRAL_STATUS = {
  PENDING: "pending",
  COMPLETED: "completed",
} as const;
