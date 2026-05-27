interface ElementLike {
    type?: string;
    attrs?: {
        content?: string;
        id?: string | number;
        qq?: string | number;
        userId?: string | number;
        user_id?: string | number;
    };
    toString?: () => string;
}
interface SessionLike {
    app?: {
        koishi?: {
            config?: {
                nickname?: string | string[];
            };
        };
        config?: {
            nickname?: string | string[];
        };
    };
    elements?: ElementLike[];
    event?: {
        message?: {
            elements?: ElementLike[];
        };
        selfId?: string;
    };
    selfId?: string;
    bot?: {
        selfId?: string;
        sendMessage?: (channelId: string | undefined, content: unknown, guildId?: string) => unknown;
    };
    quote?: {
        user?: {
            id?: string;
        };
    };
    channelId?: string;
    guildId?: string;
    _stripped?: StrippedSession;
    stripped?: StrippedSession;
    parsed?: StrippedSession;
    __dongxuelianStrippedPatch?: boolean;
}
interface StrippedSession {
    hasAt: boolean;
    content: string;
    appel: boolean;
    atSelf: boolean;
    prefix: null;
}
interface PatchedSessionFactory {
    (event: unknown): SessionLike;
    __dongxuelianPatched?: boolean;
}
interface KoishiSessionCtor {
    prototype: SessionLike & {
        resolve?: (value: unknown) => unknown;
        send?: (content: unknown) => Promise<unknown>;
    };
}
interface KoishiBotCtor {
    prototype: {
        session?: PatchedSessionFactory;
    };
}
interface SessionCompatibilityOptions {
    KoishiSession?: KoishiSessionCtor;
    KoishiBot?: KoishiBotCtor;
}
declare function patchElementText(element: ElementLike | string | undefined | null): string;
declare function patchElementsToText(elements: Array<ElementLike | string> | undefined | null): string;
declare function patchElementId(element: ElementLike | undefined): string;
declare function patchStripNickname(session: SessionLike, content: string): string | null;
declare function patchBuildStripped(session: SessionLike): StrippedSession;
declare function patchInstallAccessors(target: SessionLike | null | undefined): void;
declare function patchEnsureSession<T>(session: T): T;
declare function installSessionCompatibility({ KoishiSession, KoishiBot }?: SessionCompatibilityOptions): void;
declare const _default: {
    patchElementText: typeof patchElementText;
    patchElementsToText: typeof patchElementsToText;
    patchElementId: typeof patchElementId;
    patchStripNickname: typeof patchStripNickname;
    patchBuildStripped: typeof patchBuildStripped;
    patchInstallAccessors: typeof patchInstallAccessors;
    patchEnsureSession: typeof patchEnsureSession;
    installSessionCompatibility: typeof installSessionCompatibility;
};
export = _default;
