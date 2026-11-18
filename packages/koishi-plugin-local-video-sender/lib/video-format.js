"use strict";
/**
 * 视频媒体元数据的格式选择。
 * 只比较已有元数据，不访问下载器、磁盘、网络或资源闸门。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeNumber = safeNumber;
exports.pickFormat = pickFormat;
// --- 固定格式与排序 --- #
const MIN_720_HEIGHT = 700;
const MAX_720_HEIGHT = 720;
const PREFERRED_MAX_HEIGHT = 720;
const FORMAT_CANDIDATES = [
    { format: '30064+30280', label: '720P AVC' },
    { format: '30066+30280', label: '720P HEVC' },
    { format: '100024+30280', label: '720P AV1' },
];
const SINGLE_FILE_CANDIDATES = [
    { format: '64', label: '720P single file' },
    { format: '32', label: '480P single file' },
    { format: '16', label: '360P single file' },
];
// 缺少或非有限的数值按零参与格式计量。
function safeNumber(value) {
    return Number.isFinite(value) ? Number(value) : 0;
}
// 优先使用实际文件大小，再使用下载器提供的估算值。
function estimateFormatSize(format) {
    return safeNumber(format.filesize) || safeNumber(format.filesize_approx);
}
// 筛选不含视频轨且有有效音频编码的格式。
function isAudioOnlyFormat(format) {
    return !!(format && format.vcodec === 'none' && format.acodec && format.acodec !== 'none');
}
// 筛选存在有效视频编码的格式。
function isVideoFormat(format) {
    return !!(format && format.vcodec && format.vcodec !== 'none');
}
// 按音频码率和文件大小排序，保留并列输入顺序。
function pickBestAudio(formats) {
    return formats
        .filter(isAudioOnlyFormat)
        .sort((left, right) => {
        const abrDiff = safeNumber(right.abr) - safeNumber(left.abr);
        if (abrDiff)
            return abrDiff;
        return estimateFormatSize(right) - estimateFormatSize(left);
    })[0];
}
// 按目标分辨率距离、方向、帧率和大小排列视频候选。
function sortVideoCandidates(left, right, targetHeight = PREFERRED_MAX_HEIGHT) {
    const leftHeight = safeNumber(left.height);
    const rightHeight = safeNumber(right.height);
    const leftDistance = Math.abs(leftHeight - targetHeight);
    const rightDistance = Math.abs(rightHeight - targetHeight);
    if (leftDistance !== rightDistance)
        return leftDistance - rightDistance;
    const leftPreferred = leftHeight <= targetHeight ? 1 : 0;
    const rightPreferred = rightHeight <= targetHeight ? 1 : 0;
    if (leftPreferred !== rightPreferred)
        return rightPreferred - leftPreferred;
    const heightDiff = rightHeight - leftHeight;
    if (heightDiff)
        return heightDiff;
    const fpsDiff = safeNumber(right.fps) - safeNumber(left.fps);
    if (fpsDiff)
        return fpsDiff;
    return estimateFormatSize(right) - estimateFormatSize(left);
}
// 构造分离音视频下载参数，并合计两个流的大小。
function buildSplitPick(video, audio, label) {
    return {
        format: `${video.format_id}+${audio.format_id}`,
        label,
        totalSize: estimateFormatSize(video) + estimateFormatSize(audio),
        height: safeNumber(video.height),
    };
}
// 先匹配已知格式组合，再按原分辨率和音视频规则选择。
function pickFormat(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    for (const candidate of FORMAT_CANDIDATES) {
        const [videoId, audioId] = candidate.format.split('+');
        const video = formats.find(item => String(item.format_id) === videoId);
        const audio = formats.find(item => String(item.format_id) === audioId);
        if (!video || !audio)
            continue;
        const totalSize = estimateFormatSize(video) + estimateFormatSize(audio);
        return {
            format: candidate.format,
            label: candidate.label,
            totalSize,
            height: safeNumber(video.height),
        };
    }
    const audio = pickBestAudio(formats);
    const exact720Candidates = formats
        .filter(item => {
        const height = safeNumber(item.height);
        return isVideoFormat(item) && height >= MIN_720_HEIGHT && height <= MAX_720_HEIGHT;
    })
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (exact720Candidates.length && audio) {
        return buildSplitPick(exact720Candidates[0], audio, `${safeNumber(exact720Candidates[0].height)}P split stream`);
    }
    const preferredVideoCandidates = formats
        .filter(item => {
        const height = safeNumber(item.height);
        return isVideoFormat(item) && height > 0 && height <= PREFERRED_MAX_HEIGHT;
    })
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (preferredVideoCandidates.length && audio) {
        return buildSplitPick(preferredVideoCandidates[0], audio, `${safeNumber(preferredVideoCandidates[0].height)}P split stream`);
    }
    for (const candidate of SINGLE_FILE_CANDIDATES) {
        const merged = formats.find(item => String(item.format_id) === candidate.format);
        if (!merged)
            continue;
        return {
            format: candidate.format,
            label: candidate.label,
            totalSize: estimateFormatSize(merged),
            height: safeNumber(merged.height),
        };
    }
    const anyVideoCandidates = formats
        .filter(item => isVideoFormat(item) && safeNumber(item.height) > 0)
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (anyVideoCandidates.length && audio) {
        return buildSplitPick(anyVideoCandidates[0], audio, `${safeNumber(anyVideoCandidates[0].height)}P fallback split stream`);
    }
    const anyMergedCandidates = formats
        .filter(item => isVideoFormat(item) && item.acodec && item.acodec !== 'none')
        .sort((left, right) => sortVideoCandidates(left, right, PREFERRED_MAX_HEIGHT));
    if (anyMergedCandidates.length) {
        const merged = anyMergedCandidates[0];
        return {
            format: String(merged.format_id),
            label: `${safeNumber(merged.height)}P fallback single file`,
            totalSize: estimateFormatSize(merged),
            height: safeNumber(merged.height),
        };
    }
    return null;
}
