/**
 * MODULE: 近期上传文件产物操作兜底解析。
 * 职责: 当模型拒绝本来可由 create_uploaded_file_variant 完成的请求时，提取安全工具参数。
 * 边界: 不读写文件、不发送文件；真正操作由 create-uploaded-file-variant 工具完成。
 */
interface UploadedFileVariantRequest {
    name: string;
    sendBack?: true;
}
declare function parseUploadedFileVariantRequest(text?: string): UploadedFileVariantRequest | null;
declare function isUploadedFileVariantCapabilityRefusal(reply?: string, userText?: string): boolean;
declare function formatUploadedFileVariantFallback(result?: string): string;
declare const _default: {
    parseUploadedFileVariantRequest: typeof parseUploadedFileVariantRequest;
    isUploadedFileVariantCapabilityRefusal: typeof isUploadedFileVariantCapabilityRefusal;
    formatUploadedFileVariantFallback: typeof formatUploadedFileVariantFallback;
};
export = _default;
