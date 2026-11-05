declare function validateImageContent(dataUrl: string): Promise<{
    mime: string;
    bytes: number;
    width: number;
    height: number;
    animated: boolean;
}>;
declare const _default: {
    MAX_IMAGE_BYTES: number;
    validateImageContent: typeof validateImageContent;
};
export = _default;
