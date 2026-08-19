export const SNAPSHOT_MODES = ["text", "dom", "visual"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

export interface ImageReference {
  id: string;
  alt: string;
  src: string;
  width: number;
  height: number;
}

export interface Snapshot {
  url: string;
  title: string;
  mode: SnapshotMode;
  content: string;
  imageCount: number;
  interactiveCount: number;
  truncated: boolean;
}

export interface SnapshotOptions {
  mode: SnapshotMode;
  maxChars: number;
  selector?: string;
}

export interface BrowserConfig {
  headless: boolean;
  blockHeavyAssets: boolean;
  allowPrivateHosts: boolean;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  defaultMaxChars: number;
  maxImageBytes: number;
}

export type InteractionAction =
  | "click"
  | "fill"
  | "select"
  | "press"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "wait";

export interface InteractionInput {
  action: InteractionAction;
  ref?: string | undefined;
  value?: string | undefined;
  key?: string | undefined;
  direction?: "up" | "down" | "top" | "bottom" | undefined;
  amount?: number | undefined;
  waitMs?: number | undefined;
}

export interface RetrievedImage {
  id: string;
  alt: string;
  sourceUrl: string;
  mimeType: string;
  data: string;
  byteLength: number;
}
