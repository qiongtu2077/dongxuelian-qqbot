/**
 * 视频媒体元数据的格式选择。
 * 只比较已有元数据，不访问下载器、磁盘、网络或资源闸门。
 */
interface VideoFormat {
    format_id?: string | number;
    format_note?: string;
    ext?: string;
    filesize?: number;
    filesize_approx?: number;
    height?: number;
    fps?: number;
    abr?: number;
    vcodec?: string;
    acodec?: string;
    url?: string;
}
export interface VideoInfo {
    title?: string;
    thumbnail?: string;
    webpage_url?: string;
    original_url?: string;
    url?: string;
    id?: string;
    display_id?: string;
    duration?: number;
    formats?: VideoFormat[];
}
export interface FormatPick {
    format: string;
    label: string;
    totalSize: number;
    height: number;
}
export declare function safeNumber(value: unknown): number;
export declare function pickFormat(info: VideoInfo): FormatPick | null;
export {};
