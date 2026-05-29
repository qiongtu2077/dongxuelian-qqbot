declare function resolveGalleryId(id: any): any;
declare function galleryMimeFromName(name: any): any;
declare function listGalleryImages(): {
    id: any;
    name: any;
    size: any;
    mtimeMs: any;
    mime: any;
    url: string;
    foilStyle: string;
}[];
declare function handleGetGallery(req: any, res: any): any;
declare function handlePostGallery(req: any, res: any): void;
declare function handleDeleteGallery(req: any, res: any): void;
declare function handlePutGalleryStyle(req: any, res: any): void;
declare function handleGetGalleryImage(req: any, res: any, pathname: any): void;
declare const _default: {
    routes: {
        'GET /dashboard/api/gallery': typeof handleGetGallery;
        'POST /dashboard/api/gallery': typeof handlePostGallery;
        'DELETE /dashboard/api/gallery': typeof handleDeleteGallery;
        'PUT /dashboard/api/gallery/style': typeof handlePutGalleryStyle;
    };
    prefixRoutes: {
        prefix: string;
        method: string;
        handler: typeof handleGetGalleryImage;
    }[];
    listGalleryImages: typeof listGalleryImages;
    resolveGalleryId: typeof resolveGalleryId;
    galleryMimeFromName: typeof galleryMimeFromName;
};
export = _default;
