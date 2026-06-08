import type { IncomingMessage, ServerResponse } from 'http';
interface GalleryItem {
    id: string;
    name: string;
    size: number;
    mtimeMs: number;
    mime: string;
    url: string;
    foilStyle: string | null;
}
type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown;
interface PrefixRoute {
    prefix: string;
    method: string;
    handler: RouteHandler;
}
declare function resolveGalleryId(id: unknown): string;
declare function galleryMimeFromName(name: unknown): string;
declare function listGalleryImages(): GalleryItem[];
declare const _default: {
    routes: Record<string, RouteHandler>;
    prefixRoutes: PrefixRoute[];
    listGalleryImages: typeof listGalleryImages;
    resolveGalleryId: typeof resolveGalleryId;
    galleryMimeFromName: typeof galleryMimeFromName;
};
export = _default;
