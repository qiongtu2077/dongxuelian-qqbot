interface NotificationBot {
    sendPrivateMessage?: (id: string, message: string) => Promise<unknown> | unknown;
    internal?: {
        sendPrivateMsg?: (id: string, message: unknown) => Promise<unknown> | unknown;
    };
}
interface NotificationContext {
    bots?: NotificationBot[];
    bot?: NotificationBot;
}
type FailureSender = (adminId: string, message: string) => Promise<unknown>;
declare function setCapabilityFailureSender(sender: FailureSender | null): void;
declare function registerCapabilityFailureContext(ctx: NotificationContext): void;
declare function notifyCapabilityStepFailure(providerId: string, model: string, now?: number): Promise<boolean>;
declare function resetCapabilityFailureNotifier(): void;
declare const _default: {
    FAILURE_NOTIFICATION_COOLDOWN_MS: number;
    setCapabilityFailureSender: typeof setCapabilityFailureSender;
    registerCapabilityFailureContext: typeof registerCapabilityFailureContext;
    notifyCapabilityStepFailure: typeof notifyCapabilityStepFailure;
    resetCapabilityFailureNotifier: typeof resetCapabilityFailureNotifier;
};
export = _default;
