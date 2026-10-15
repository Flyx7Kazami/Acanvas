export interface ContentEditorRegistration {
  sessionId: string;
  objectId: string;
  flush: () => Promise<void>;
  isDirty: () => boolean;
  isComposing: () => boolean;
}

export type RegisterContentEditor = (registration: ContentEditorRegistration) => () => void;

export interface ContentSaveResult {
  objectId: string;
  assetId: string;
  version: number;
}
