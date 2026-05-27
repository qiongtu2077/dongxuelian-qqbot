interface SceneAnchor {
    type: string;
    label: string;
    messageId?: string;
}
interface RawSceneEntry {
    content?: unknown;
    ts?: number | string;
    messageId?: string | number;
    speakerName?: string;
    role?: string;
    personaName?: string;
    userId?: string | number;
    replyToId?: string | number;
    mentionUserIds?: Array<string | number>;
    hasMessageRecordCue?: boolean;
}
interface SceneSnippet {
    messageId: string;
    ts: number;
    speakerName: string;
    role: 'assistant' | 'user';
    personaName: string;
    content: string;
    hasMessageRecordCue: boolean;
}
interface GroupScene {
    id: string;
    channelKey: string;
    startTs: number;
    endTs: number;
    messageIds: string[];
    speakers: string[];
    speakerCount: number;
    anchors: SceneAnchor[];
    keywords: string[];
    samples: string[];
    snippets: SceneSnippet[];
    state: string;
    source: string;
}
interface GroupSceneData {
    version: number;
    updatedAt: number;
    scenes: GroupScene[];
}
interface SceneItemLike {
    userId?: string;
    role?: string;
    speakerName?: string;
    personaName?: string;
    content?: string;
    messageId?: string;
    replyToId?: string;
    hasMessageRecordCue?: boolean;
    ts?: number;
}
interface ActiveSceneOptions {
    now?: number;
    currentMessageId?: string | number;
    currentReplyToId?: string | number;
    currentUserId?: string | number;
    currentText?: string;
    directAt?: boolean;
    nameMentioned?: boolean;
    isDirect?: boolean;
    randomTriggered?: boolean;
    personaName?: string;
}
interface ActiveSceneLayers {
    currentTurn: SceneItemLike[];
    hotContext: SceneItemLike[];
    oldBackground: SceneItemLike[];
}
interface ReadGroupContextArgs {
    sceneId?: string;
    query?: string;
    reason?: string;
    maxAgeMinutes?: number | string;
    maxScenes?: number | string;
    anchorType?: string;
    timeHint?: string;
}
declare function getSceneFilePath(channelKey?: string): string;
declare function sanitizeSceneText(text?: unknown, maxChars?: number): string;
declare function extractSceneAnchors(content?: string): SceneAnchor[];
declare function extractSceneKeywords(content?: string): string[];
declare function loadGroupScenes(channelKey: string): Promise<GroupSceneData>;
declare function appendGroupSceneEntry(channelKey: string, rawEntry?: RawSceneEntry): Promise<boolean>;
declare function classifySceneItemsForActive(items?: SceneItemLike[], options?: ActiveSceneOptions): ActiveSceneLayers;
declare function buildActiveGroupSceneNote(channelKey: string, items?: SceneItemLike[], currentUserId?: string, options?: ActiveSceneOptions): string;
declare function readGroupContext(channelKey: string, args?: ReadGroupContextArgs): Promise<string>;
declare const _default: {
    GROUP_SCENE_VERSION: number;
    GROUP_SCENE_DIR: string;
    safeSceneChannelKey: (value?: string) => string;
    getSceneFilePath: typeof getSceneFilePath;
    sanitizeSceneText: typeof sanitizeSceneText;
    extractSceneAnchors: typeof extractSceneAnchors;
    extractSceneKeywords: typeof extractSceneKeywords;
    appendGroupSceneEntry: typeof appendGroupSceneEntry;
    loadGroupScenes: typeof loadGroupScenes;
    readGroupContext: typeof readGroupContext;
    buildActiveGroupSceneNote: typeof buildActiveGroupSceneNote;
    classifySceneItemsForActive: typeof classifySceneItemsForActive;
};
export = _default;
