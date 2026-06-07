interface EmotionAnalysis {
    score: number;
    mood?: string;
    confidence: number;
    summary: string;
    keywords?: string[];
    reasons?: string[];
}
interface EmotionStats {
    messageCount: number;
    userCount: number;
}
interface EmotionHistoryItem {
    date: string;
    score: number;
    summary?: string;
}
declare function renderEmotionHtml(analysis: EmotionAnalysis, stats: EmotionStats, history?: EmotionHistoryItem[]): string;
declare function renderEmotionImage(analysis: EmotionAnalysis, stats: EmotionStats, history?: EmotionHistoryItem[], channelKey?: string): Promise<unknown>;
declare function renderEmotionImageDirect(analysis: EmotionAnalysis, stats: EmotionStats, history?: EmotionHistoryItem[]): Promise<unknown>;
declare const _default: {
    renderEmotionHtml: typeof renderEmotionHtml;
    renderEmotionImage: typeof renderEmotionImage;
    renderEmotionImageDirect: typeof renderEmotionImageDirect;
};
export = _default;
