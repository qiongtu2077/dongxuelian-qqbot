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
declare function parseFrontmatter(content: any): {
    meta: any;
    body: any;
    raw: string;
};
declare function buildPersonaFrontmatter(meta: FrontmatterMeta, overrides?: FrontmatterMeta): string;
declare function cleanLoreName(value: any): string;
declare function normalizeLoreScope(value: any): "none" | "always" | "keyword";
declare function normalizeLorePayload(data?: FrontmatterMeta, existingName?: string): LorePayload;
declare function buildLoreFrontmatter(meta: FrontmatterMeta, overrides?: FrontmatterMeta): string;
declare function handleGetStatus(req: any, res: any): any;
declare function handleGetProviders(req: any, res: any): any;
declare function handleGetConfig(req: any, res: any): any;
declare function handlePutConfig(req: any, res: any): void;
declare function handleGetPersonas(req: any, res: any, pathname: any, url: any): any;
declare function handlePostPersonas(req: any, res: any): void;
declare function handleDeletePersonas(req: any, res: any): void;
declare function handlePutPersonas(req: any, res: any): void;
declare function handleGetLoreList(req: any, res: any): any;
declare function handleGetLores(req: any, res: any): any;
declare function handlePostLores(req: any, res: any): void;
declare function handlePutLores(req: any, res: any): void;
declare function handleDeleteLores(req: any, res: any): void;
declare function handleGetModes(req: any, res: any): any;
declare function handleGetPersonaDiagnostics(req: any, res: any): any;
declare const _default: {
    routes: {
        'GET /dashboard/api/status': typeof handleGetStatus;
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
