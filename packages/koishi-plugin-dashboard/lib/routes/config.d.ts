import type { IncomingMessage, ServerResponse } from 'http';
type LoreScope = 'always' | 'keyword' | 'none';
interface ParsedDashboardFrontmatter {
    meta: FrontmatterMeta;
    body: string;
    raw: string;
}
interface FrontmatterMeta {
    [key: string]: unknown;
    name?: string;
    description?: string;
    lore?: string;
    will?: string | number;
    nsfw?: string;
    voice?: string;
    voice_id?: string;
    voice_asset_id?: string;
    voice_style?: string;
    keywords?: string;
    scope?: string;
    summary?: string;
    maxChars?: string | number;
    max_chars?: string | number;
    priority?: string | number;
    content?: string;
}
interface LorePayload extends FrontmatterMeta {
    content: string;
}
declare function parseFrontmatter(content: unknown): ParsedDashboardFrontmatter;
declare function buildPersonaFrontmatter(meta: FrontmatterMeta, overrides?: FrontmatterMeta): string;
declare function cleanLoreName(value: unknown): string;
declare function normalizeLoreScope(value: unknown): LoreScope;
declare function normalizeLorePayload(data?: FrontmatterMeta, existingName?: string): LorePayload;
declare function buildLoreFrontmatter(meta: FrontmatterMeta, overrides?: FrontmatterMeta): string;
declare function handleGetStatus(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetReleaseStatus(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetProviders(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetConfig(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutConfig(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetPersonas(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): void;
declare function handlePostPersonas(req: IncomingMessage, res: ServerResponse): void;
declare function handleDeletePersonas(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutPersonas(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetLoreList(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetLores(req: IncomingMessage, res: ServerResponse): void;
declare function handlePostLores(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutLores(req: IncomingMessage, res: ServerResponse): void;
declare function handleDeleteLores(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetModes(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetPersonaDiagnostics(req: IncomingMessage, res: ServerResponse): void;
declare const _default: {
    routes: {
        'GET /dashboard/api/status': typeof handleGetStatus;
        'GET /dashboard/api/release-status': typeof handleGetReleaseStatus;
        'GET /dashboard/api/providers': typeof handleGetProviders;
        'GET /dashboard/api/config': typeof handleGetConfig;
        'PUT /dashboard/api/config': typeof handlePutConfig;
        'GET /dashboard/api/personas': typeof handleGetPersonas;
        'POST /dashboard/api/personas': typeof handlePostPersonas;
        'DELETE /dashboard/api/personas': typeof handleDeletePersonas;
        'PUT /dashboard/api/personas': typeof handlePutPersonas;
        'GET /dashboard/api/lore-list': typeof handleGetLoreList;
        'GET /dashboard/api/lores': typeof handleGetLores;
        'POST /dashboard/api/lores': typeof handlePostLores;
        'PUT /dashboard/api/lores': typeof handlePutLores;
        'DELETE /dashboard/api/lores': typeof handleDeleteLores;
        'GET /dashboard/api/modes': typeof handleGetModes;
        'GET /dashboard/api/persona-diagnostics': typeof handleGetPersonaDiagnostics;
    };
    _test: {
        parseFrontmatter: typeof parseFrontmatter;
        buildPersonaFrontmatter: typeof buildPersonaFrontmatter;
        parseModeFrontmatter: typeof parseFrontmatter;
        cleanLoreName: typeof cleanLoreName;
        normalizeLoreScope: typeof normalizeLoreScope;
        normalizeLorePayload: typeof normalizeLorePayload;
        buildLoreFrontmatter: typeof buildLoreFrontmatter;
    };
};
export = _default;
