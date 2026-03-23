export type ContainerStatus = 'running' | 'stopped' | 'creating' | 'error';
export type ContainerType = 'local' | 'host' | 'bridge' | 'docker';

export interface SessionTarget {
  containerId: string;
  sessionName: string;
  windowIndex: number;
}

export interface FoldedSessionTarget {
  containerId: string;
  sessionName: string;
  sessionId: string;
  folded: true;
  lastWindowIndex?: number;
}

export interface FoldedContainerTarget {
  containerId: string;
  containerFolded: true;
  lastSelection?: SessionTarget | FoldedSessionTarget;
}

export type Selection = SessionTarget | FoldedSessionTarget | FoldedContainerTarget;

export function isWindowSelection(s: Selection): s is SessionTarget {
  return !('folded' in s) && !('containerFolded' in s);
}

export function isFoldedSelection(s: Selection): s is FoldedSessionTarget {
  return 'folded' in s && s.folded === true;
}

export function isFoldedContainerSelection(s: Selection): s is FoldedContainerTarget {
  return 'containerFolded' in s && s.containerFolded === true;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: number;
  bell: boolean;
  activity: boolean;
  command?: string;
  paneStatus?: string;
  path?: string;
}

export interface TmuxSession {
  id: string;
  name: string;
  windows: TmuxWindow[];
  created: string;
  attached: boolean;
  summary?: string;
  source?: string;
}

export interface Container {
  id: string;
  name: string;
  displayName: string;
  status: ContainerStatus;
  image: string;
  containerType?: ContainerType;
  templateId?: string;
  sessions: TmuxSession[];
  createdAt: string;
}

export interface ContainerListResponse {
  containers: Container[];
  dockerError?: string;
  missingSnapshotSessions?: number;
  driftedSnapshotSessions?: number;
}

export interface Template {
  id: string;
  name: string;
  type: 'dockerfile' | 'compose';
  content: string;
  buildArgs: Record<string, string>;
  defaultVolumes: string[];
  defaultEnv: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramLink {
  id: string;
  chatId: number;
  dockerContainerId: string;
  tmuxSession: string;
  isActive: boolean;
  createdAt: string;
}

export interface TelegramChat {
  chatId: number;
  username: string | null;
  firstName: string | null;
}

export interface Settings {
  telegramBotToken: string;
  telegramAllowedUsers: string[];
  defaultVolumeMounts: string[];
  sshKeyPath: string;
  terminalPoolSize?: number;
  telegramRegistrationSecret?: string;
  telegramNotificationsEnabled?: boolean;
  telegramNotificationTimeoutSecs?: number;
  openaiApiKey?: string;
  chatModel?: string;
  audioDebugLog?: boolean;
  telegramVoiceNotifications?: boolean;
  hotkeys?: Record<string, string>;
  snapshotEnabled?: boolean;
}

export interface ClaudeNotification {
  id: string;
  message: string;
  title: string;
  notificationType: string;
  sessionId: string;
  containerId: string;
  tmuxSession: string;
  tmuxWindow: number;
  createdAt: string;
  status: string;
  channels?: string[];
}

export interface CreateContainerRequest {
  templateId: string;
  name: string;
  env: Record<string, string>;
  volumes: string[];
  mountSsh: boolean;
  mountClaude: boolean;
}

export type ContainerStreamEvent =
  | { event: 'step'; step: string; message: string }
  | { event: 'log'; line: string }
  | { event: 'complete'; container: Container }
  | { event: 'error'; step?: string; message: string };

export interface AuthStatus {
  authenticated: boolean;
  pinSet: boolean;
  locked?: boolean;
  webauthnEnabled?: boolean;
}

export interface WebAuthnCredential {
  id: string;
  name: string;
  createdAt: string;
  transports: string[];
}

export interface CreateSessionRequest {
  name: string;
}

export interface CreateWindowRequest {
  name?: string;
}

export interface RelayConfig {
  id: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  connected: boolean;
}

export interface BridgeSettings {
  compression?: boolean;
  reportIntervalSec?: number;
  pingIntervalSec?: number;
  coalesceMs?: number;
}

export interface BridgeConfig {
  id: string;
  name: string;
  token: string | null;
  connected: boolean;
  enabled: boolean;
  autoTune?: boolean;
  lanMode?: boolean;
  createdAt: string;
  latencyLastMs: number | null;
  latencyMinMs: number | null;
  latencyMaxMs: number | null;
  latencyP90Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  latencyJitterMs: number | null;
  latencyHistory: number[];
  wsRxBinFrames: number;
  wsRxBinBytes: number;
  wsRxTextFrames: number;
  wsFwdTasks: number;
  settings?: BridgeSettings | null;
  capabilities?: Record<string, unknown> | null;
  negotiatedSettings?: BridgeSettings | null;
}

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  detail?: string;
}

// Snapshot types (snake_case — raw Python dict, not Pydantic CamelModel)
export interface SnapshotWindow { index: number; name: string; path: string; }
export interface SnapshotSession { name: string; windows: SnapshotWindow[]; }
export interface SnapshotContainer { id: string; display_name: string; container_type: string; status: string; sessions: SnapshotSession[]; }
export interface Snapshot { timestamp: string | null; containers: SnapshotContainer[]; }
export interface RestoreResult { restored: string[]; skipped: string[]; errors: string[]; }
