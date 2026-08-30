/** Loads production modules and verifies their public export contracts. */
async function runModuleContract(context) {
  const {
    fs, path, dns, spawnSync,
    ROOT, PKG_ROOT, AI_ROOT, LIB, HELP, TEST_ROOT,
    STR, CMD, rootPkg, constantsSrc,
    section, pass, fail, skip, check, checkEqual, checkIncludes, checkThrows,
    read, readJson, runSyntaxCheck, runShellSyntaxCheck, gitCheckIgnored, gitTrackedFiles,
    makeLoggerStore, makeSession, makeHandlerState, runHandler, getCounts,
  } = context
  const modules = {}
  section('2. module loading and exports')
  const modPaths = {
    constants: path.join(LIB, 'core', 'constants'),
    frontmatter: path.join(LIB, 'core', 'frontmatter'),
    onebotEndpoint: path.join(LIB, 'core', 'onebot-endpoint'),
    redactor: path.join(LIB, 'core', 'redactor'),
    utils: path.join(LIB, 'core', 'utils'),
    persona: path.join(LIB, 'persona', 'persona'),
    personaSchema: path.join(LIB, 'persona', 'persona-schema'),
    personaDiagnostics: path.join(LIB, 'persona', 'persona-diagnostics'),
    personaRuntimePlan: path.join(LIB, 'persona', 'persona-runtime-plan'),
    personaProfile: path.join(LIB, 'persona', 'persona-profile'),
    personaProfileSources: path.join(LIB, 'persona', 'persona-profile-sources'),
    personaLoreRouter: path.join(LIB, 'persona', 'persona-lore-router'),
    skillsLoader: path.join(LIB, 'persona', 'skills', 'skills-loader'),
    skillSeeds: path.join(LIB, 'persona', 'skills', 'skill-seeds'),
    externalToolPolicy: path.join(LIB, 'routing', 'external-tool-policy'),
    replyTiming: path.join(LIB, 'reply', 'reply-timing'),
    affectRouter: path.join(LIB, 'behavior', 'affect-router'),
    stickerShadow: path.join(LIB, 'behavior', 'sticker-shadow'),
    diagnostics: path.join(LIB, 'diagnostics', 'diagnostics'),
    groupSceneIndex: path.join(LIB, 'routing', 'group-scene-index'),
    randomReplyMode: path.join(LIB, 'behavior', 'random-reply-mode'),
    randomPersonaRisk: path.join(LIB, 'behavior', 'random-persona-risk'),
    sessionCompat: path.join(LIB, 'lifecycle', 'session-compat'),
    botResolver: path.join(LIB, 'lifecycle', 'bot-resolver'),
    channelTaskQueue: path.join(LIB, 'lifecycle', 'channel-task-queue'),
    eventDump: path.join(LIB, 'lifecycle', 'event-dump'),
    startupSchedulers: path.join(LIB, 'lifecycle', 'startup-schedulers'),
    pluginLifecycle: path.join(LIB, 'lifecycle', 'plugin-lifecycle'),
    messageSegment: path.join(LIB, 'message', 'message-segment'),
    incomingFile: path.join(LIB, 'media', 'file', 'incoming-file'),
    incomingMessageFlow: path.join(LIB, 'message', 'incoming-message-flow'),
    sharedRecordText: path.join(LIB, 'diagnostics', 'shared-record-text'),
    fileQuickRead: path.join(LIB, 'routing', 'file-quick-read'),
    runtimeSettings: path.join(LIB, 'behavior', 'runtime-settings'),
    userBlacklist: path.join(LIB, 'core', 'user-blacklist'),
    safeSend: path.join(LIB, 'reply', 'safe-send'),
    randomState: path.join(LIB, 'behavior', 'random-state'),
    api: path.join(LIB, 'core', 'api'),
    conversation: path.join(LIB, 'conversation'),
    fileSafety: path.join(LIB, 'media', 'file', 'file-safety'),
    fileFollowupState: path.join(LIB, 'media', 'file', 'file-followup-state'),
    fileFollowupEvidence: path.join(LIB, 'chat', 'file-followup-evidence'),
    fileStore: path.join(LIB, 'media', 'file', 'file-store'),
    fileAnalyzer: path.join(LIB, 'media', 'file', 'file-analyzer'),
    handler: path.join(LIB, 'handler'),
    commandResult: path.join(LIB, 'commands', 'command-result'),
    voiceCommand: path.join(LIB, 'commands', 'voice-command'),
    memoryCommand: path.join(LIB, 'commands', 'memory-command'),
    planCommand: path.join(LIB, 'commands', 'plan-command'),
    agentCommand: path.join(LIB, 'commands', 'agent-command'),
    emotionCommand: path.join(LIB, 'commands', 'emotion-command'),
    messageReader: path.join(LIB, 'message', 'message-reader'),
    searchContext: path.join(LIB, 'routing', 'search-context'),
    chat: path.join(LIB, 'chat'),
    chatPromptBuilder: path.join(LIB, 'chat', 'chat-prompt-builder'),
    chatMemory: path.join(LIB, 'chat', 'chat-memory'),
    chatToolFlow: path.join(LIB, 'chat', 'chat-tool-flow'),
    chatFinalOutputFlow: path.join(LIB, 'chat', 'chat-final-output-flow'),
    chatJailbreakFlow: path.join(LIB, 'chat', 'chat-jailbreak-flow'),
    chatTopicSwitch: path.join(LIB, 'chat', 'chat-topic-switch'),
    chatAgentRetellFlow: path.join(LIB, 'chat', 'chat-agent-retell-flow'),
    chatResultFlow: path.join(LIB, 'chat', 'chat-result-flow'),
    chatSendFlow: path.join(LIB, 'chat', 'chat-send-flow'),
    resourceDirective: path.join(LIB, 'resource-scheduler', 'resource-directive'),
    backgroundDirective: path.join(LIB, 'resource-scheduler', 'background-directive'),
    resourceActivityLease: path.join(LIB, 'resource-scheduler', 'resource-activity-lease'),
    resourceTaskStore: path.join(LIB, 'resource-workers', 'task-store'),
    agentAutoRouteFlow: path.join(LIB, 'routing', 'agent-auto-route-flow'),
    agentChatBridge: path.join(LIB, 'chat', 'agent-chat-bridge'),
    agentRetellGuard: path.join(LIB, 'chat', 'agent-retell-guard'),
    resultNotifier: path.join(LIB, 'resource-workers', 'result-notifier'),
    resourceFiles: path.join(LIB, 'resource-common', 'files'),
    resourceTaskKinds: path.join(LIB, 'resource-common', 'resource-task-kinds'),
    personaFallback: path.join(LIB, 'persona', 'persona-fallback'),
    jailbreakRuleset: path.join(LIB, 'rulesets', 'jailbreak'),
    loggingConfig: path.join(LIB, 'core', 'logging-config'),
    runtimeConfig: path.join(LIB, 'core', 'runtime-config'),
    reply: path.join(LIB, 'reply', 'reply'),
    replyGuard: path.join(LIB, 'reply', 'reply-guard'),
    repeat: path.join(LIB, 'behavior', 'repeat'),
    forward: path.join(LIB, 'message', 'forward'),
    vision: path.join(LIB, 'media', 'image', 'vision'),
    sensitive: path.join(LIB, 'behavior', 'sensitive'),
    retaliation: path.join(LIB, 'behavior', 'retaliation'),
    sendGuard: path.join(LIB, 'reply', 'send-guard'),
    healthCheck: path.join(LIB, 'diagnostics', 'health-check'),
    agentEngine: path.join(LIB, 'agent', 'engine'),
    agentMessages: path.join(LIB, 'agent', 'messages'),
    agentConfig: path.join(LIB, 'agent', 'config'),
    agentContext: path.join(LIB, 'agent', 'context'),
    agentPersonaContext: path.join(LIB, 'agent', 'persona-context'),
    agentWorkspaceContext: path.join(LIB, 'agent', 'workspace-context'),
    agentSearchQuery: path.join(LIB, 'agent', 'search-query'),
    agentSearchResults: path.join(LIB, 'agent', 'search-results'),
    agentFetchReader: path.join(LIB, 'agent', 'fetch-reader'),
    agentHttpSearch: path.join(LIB, 'agent', 'http-search'),
    agentQueue: path.join(LIB, 'agent', 'queue'),
    agentMemory: path.join(LIB, 'agent', 'memory'),
    chatTools: path.join(LIB, 'chat', 'chat-tools'),
    chatToolPolicy: path.join(LIB, 'chat', 'chat-tool-policy'),
    agentAutoMemory: path.join(LIB, 'agent', 'auto-memory'),
    agentDream: path.join(LIB, 'agent', 'dream'),
    agentPush: path.join(LIB, 'agent', 'push'),
    agentCron: path.join(LIB, 'agent', 'cron'),
    agentPlanStore: path.join(LIB, 'agent', 'plan', 'plan-store'),
    agentPlanEngine: path.join(LIB, 'agent', 'plan', 'plan-engine'),
    agentPlanPrompts: path.join(LIB, 'agent', 'plan', 'plan-prompts'),
    agentPlanTools: path.join(LIB, 'agent', 'plan', 'plan-tools'),
    agentPlanRunner: path.join(LIB, 'agent', 'plan', 'plan-runner'),
    agentPathGuard: path.join(LIB, 'agent', 'path-guard'),
    agentSkills: path.join(LIB, 'agent', 'skills'),
    agentSkillHub: path.join(LIB, 'agent', 'skill-hub'),
    agentSkillScanner: path.join(LIB, 'agent', 'skills', 'scanner'),
    agentSkillStore: path.join(LIB, 'agent', 'skills', 'store'),
    agentSkillPoolService: path.join(LIB, 'agent', 'skills', 'pool-service'),
    agentSkillWorkspaceService: path.join(LIB, 'agent', 'skills', 'workspace-service'),
    agentSkillHubDownload: path.join(LIB, 'agent', 'skills', 'hub'),
    agentSkillHubGithub: path.join(LIB, 'agent', 'skills', 'hub-github'),
    agentRouter: path.join(LIB, 'agent', 'router'),
    agentWorkerSubmission: path.join(LIB, 'agent', 'worker-submission'),
    agentSessions: path.join(LIB, 'agent', 'sessions'),
    agentStats: path.join(LIB, 'agent', 'stats'),
    agentPending: path.join(LIB, 'agent', 'pending'),
    agentSafety: path.join(LIB, 'agent', 'safety'),
    agentToolRegistry: path.join(LIB, 'agent', 'tools', 'registry'),
    agentToolTime: path.join(LIB, 'agent', 'tools', 'get-time'),
    agentToolCalculator: path.join(LIB, 'agent', 'tools', 'calculator'),
    agentToolWebSearch: path.join(LIB, 'agent', 'tools', 'web-search'),
    agentToolWebFetch: path.join(LIB, 'agent', 'tools', 'web-fetch'),
    agentToolReadAgentSkill: path.join(LIB, 'agent', 'tools', 'read-agent-skill'),
    agentToolReadFile: path.join(LIB, 'agent', 'tools', 'read-file'),
    agentToolListFiles: path.join(LIB, 'agent', 'tools', 'list-files'),
    agentToolBrowserAction: path.join(LIB, 'agent', 'tools', 'browser-action'),
    agentToolFindFiles: path.join(LIB, 'agent', 'tools', 'find-files'),
    agentToolWriteFile: path.join(LIB, 'agent', 'tools', 'write-file'),
    agentToolEditFile: path.join(LIB, 'agent', 'tools', 'edit-file'),
    agentToolShell: path.join(LIB, 'agent', 'tools', 'shell'),
    agentToolShellGuard: path.join(LIB, 'agent', 'tools', 'shell-guard'),
    agentToolMemoryTools: path.join(LIB, 'agent', 'tools', 'memory-tools'),
    agentToolAppendFile: path.join(LIB, 'agent', 'tools', 'append-file'),
    agentToolGrepSearch: path.join(LIB, 'agent', 'tools', 'grep-search'),
    agentToolExecuteJavascript: path.join(LIB, 'agent', 'tools', 'execute-javascript'),
    agentToolSendFileToUser: path.join(LIB, 'agent', 'tools', 'send-file-to-user'),
    agentToolCreateUploadedFileVariant: path.join(LIB, 'agent', 'tools', 'create-uploaded-file-variant'),
    agentToolGetTokenUsage: path.join(LIB, 'agent', 'tools', 'get-token-usage'),
    agentToolSetUserTimezone: path.join(LIB, 'agent', 'tools', 'set-user-timezone'),
    agentToolQueryLogs: path.join(LIB, 'agent', 'tools', 'query-logs'),
    agentToolCreateReminder: path.join(LIB, 'agent', 'tools', 'create-reminder'),
    agentToolReminderTools: path.join(LIB, 'agent', 'tools', 'reminder-tools'),
    agentToolScheduledTaskTools: path.join(LIB, 'agent', 'tools', 'scheduled-task-tools'),
    agentToolAnalyzeFile: path.join(LIB, 'agent', 'tools', 'analyze-file'),
    mcpLocalServer: path.join(LIB, 'mcp', 'local-server'),
    rareVoice: path.join(LIB, 'behavior', 'rare-voice'),
    voiceQuickRead: path.join(LIB, 'routing', 'voice-quick-read'),
    index: path.join(LIB, 'index'),
    voice: path.join(LIB, 'media', 'voice', 'voice'),
    tts: path.join(LIB, 'media', 'voice', 'tts'),
    randomVoiceRate: path.join(LIB, 'behavior', 'random-voice-rate'),
    voiceAssets: path.join(LIB, 'media', 'voice', 'voice-assets'),
    imageStore: path.join(LIB, 'media', 'image', 'image-store'),
    imageAnalyzer: path.join(LIB, 'media', 'image', 'image-analyzer'),
    imageAnalysisSanitizer: path.join(LIB, 'media', 'image', 'image-analysis-sanitizer'),
    publicManagementRuntime: path.join(LIB, 'public', 'management-runtime'),
    help: path.join(HELP, 'index'),
  }
  for (const [name, modulePath] of Object.entries(modPaths)) {
    try {
      modules[name] = require(modulePath)
      pass(`require ${name}`)
    } catch (error) {
      fail(`require ${name}`, error.message)
    }
  }

  const c = modules.constants
  const u = modules.utils
  const p = modules.persona
  const api = modules.api
  const conv = modules.conversation
  const reader = modules.messageReader
  const handler = modules.handler
  const index = modules.index

  const expectedExports = {
    frontmatter: [
      'normalizeFrontmatterSource', 'parseFrontmatterLines', 'parseFrontmatterDocument',
    ],
    onebotEndpoint: [
      'resolveOneBotWsUrl',
    ],
    redactor: [
      'redactSensitiveText',
    ],
    utils: [
      'splitSentences', 'normalizeText', 'sanitizeUserName', 'sanitizeUserInput', 'isJailbreakAttempt',
      'isHostileInput', 'isRareProvocation', 'isWideRareProvocation', 'getSenderUserId', 'hasAdminPermission',
      'stripMentions', 'collapseRepeatedBotCalls', 'isDirectAtBot', 'getBotMentionCount',
      'hasOtherMentions', 'formatPercent', 'readTextFile', 'writeTextFile',
      'readJsonFile', 'writeJsonFile', 'readJsonFileSync', 'writeJsonFileSync', 'safeUnlink', 'getFileFingerprint', 'sleep', 'extractImageUrls',
      'normalizeReplyFingerprint', 'isReplyTooSimilar', 'isOverusedReply',
      'hasBannedOutput', 'isThinkingLeak', 'getModelDisplayName', 'getSearchCapability',
      'formatSearchStatus',       'sanitizeReply', 'trimReply',
      'todayCst', 'formatShanghaiTime24h', 'getShanghaiHourFromTs', 'todayCstMinusDays',
      'shouldTriggerRandom', 'safeChannelKey', 'safeUserId', 'legacySafeUserId', 'truncateText',
      'normalizeHostname', 'isPrivateHostname', 'isPrivateIp', 'validatePublicHttpUrl', 'resolveAndValidateHostname',
    ],
    persona: [
      'atomicWriteJson', 'loadPersonaGroups', 'getGroupPersona', 'setGroupPersona',
      'resetGroupPersona', 'loadPersonaUsers', 'getUserPersona', 'setUserPersona',
      'resetUserPersona', 'resolvePersona', 'parsePersonaFrontmatter',
      'getAvailablePersonals', 'loadPersonalSkill',
    ],
    personaSchema: [
      'normalizePersonaSchemaScalar', 'parsePersonaSchemaFrontmatter', 'stripPersonaFrontmatter',
      'createPersonaDiagnostic', 'parsePersonaNumber', 'parsePersonaStringList',
      'getPersonaSchemaKnownFields', 'validatePersonaMeta', 'parsePersonaDocument',
    ],
    personaDiagnostics: [
      'readPersonaDiagnosticText', 'listPersonaDiagnosticFiles', 'getPersonaDocumentName',
      'getDiagnosticLoreRefs', 'buildPersonaDiagnosticIndexes', 'addCrossDocumentDiagnostics',
      'summarizePersonaDiagnostics', 'scanPersonaDocuments', 'formatPersonaDiagnosticReport',
    ],
    personaRuntimePlan: [
      'normalizePersonaRuntimeText', 'normalizePersonaRuntimeNsfw',
      'compilePersonaRuntimePlan', 'resolvePersonaRuntimePlan', 'getPersonaRuntimePlanLegacySnapshot',
    ],
    personaProfile: [
      'hashPersonaProfileValue', 'sanitizePersonaProfileKey', 'normalizePersonaProfileText',
      'buildPersonaProfileEvidence', 'buildPersonaProfileBlock',
      'reinforcePersonaProfileBlock',
      'buildPersonaProfileReinforcementShadow', 'formatPersonaProfileReinforcementShadowDiagnostic',
      'computePersonaProfileEffectiveConfidence',
      'selectPersonaProfileBlocksByEffectiveConfidence',
      'buildPersonaProfileSelectionDiagnostic', 'formatPersonaProfileSelectionDiagnostic',
      'buildPersonaProfileReinforceDiagnostic', 'formatPersonaProfileReinforceDiagnostic',
      'buildPersonaProfileBlocksFromLegacyData', 'buildPersonaProfileSourceDiagnostic',
      'formatPersonaProfileSourceDiagnostic', 'getPersonaProfileShadowLogFile',
      'buildPersonaProfileShadowPreview', 'buildPersonaProfileShadowLogEvent',
      'appendPersonaProfileShadowLog',
      'formatPersonaProfileShadowLearningDiagnostic', 'formatPersonaProfileShadowPromptPreviewDiagnostic',
      'safePersonaProfileFile',
      'readLegacyPersonaProfileData', 'buildPersonaProfileBlocks',
      'summarizePersonaProfileBlocks', 'formatPersonaProfileSummary',
    ],
    personaProfileSources: [
      'sanitizePersonaProfileKey', 'safePersonaProfileFile', 'readLegacyPersonaProfileData',
    ],
    personaLoreRouter: [
      'normalizeLoreText', 'normalizeLoreId', 'normalizeLoreScope',
      'normalizeLoreMaxChars', 'normalizeLorePriority', 'normalizeLoreKeywords',
      'getLegacyLoreKeywords', 'normalizeLoreEntry', 'resolvePersonaLoreIds',
      'findMatchedLoreKeywords', 'splitLoreChunks', 'truncateLoreText',
      'selectLoreText', 'routePersonaLore',
    ],
    skillsLoader: [
      'parseSkillPositiveInt', 'readSkillTextIfSmall', 'stripSkillFrontmatter',
      'getSkillDirectoryFingerprint', 'getSkillsContentFingerprint',
      'loadSkills', 'loadSkillsContentCache', 'refreshSkillsContentCacheIfChanged',
      'getSkillsCount', 'getSkillsContentCache',
      'buildTestSystemPrompt', 'buildFriendlySystemPrompt',
      'buildFriendlySafetyFramework', 'buildAbusiveSystemPrompt',
      'shouldInjectLore', 'shouldInjectTerraLore',
    ],
    skillSeeds: [
      'extractFrontmatterText', 'hasFrontmatter', 'migrateMissingLoreFrontmatter',
      'ensureRuntimeSkillSeeds', 'resetRuntimeSkillSeedSyncForTest',
    ],
    externalToolPolicy: [
      'externalToolsDenied', 'filterExternalToolDefinitions', 'buildExternalToolPolicyHint',
    ],
    fileSafety: [
      'checkFile', 'wrapFileContent', 'unwrapFileContent', 'summarizeFileContentForChat',
    ],
    fileStore: [
      'storeFile', 'getFileEntry', 'markFileAnalyzed', 'setLocalPath', 'getRecentFiles', 'getRecentFilesCached',
    ],
    fileAnalyzer: [
      'enqueueFileAnalysis', 'analyzeFileNow', 'downloadFile',
    ],
    personaFallback: [
      'normalizeModelText', 'isUnsafeFallbackText', 'cleanPersonaFallbackReply',
      'buildPersonaFallbackMessages', 'generatePersonaFallbackReply',
    ],
    replyTiming: [
      'replyTimingHash', 'buildReplyTimingDiagnostic', 'formatReplyTimingDiagnostic',
    ],
    affectRouter: [
      'hashAffectValue', 'normalizeAffectText', 'normalizeAffectPolicy',
      'resolveAffectPolicy', 'classifyAffectMood',
      'buildAffectRouterDiagnostic', 'formatAffectRouterDiagnostic',
    ],
    stickerShadow: [
      'stickerShadowHashValue', 'stickerShadowSanitizeSample',
      'stickerShadowInferVisual', 'buildStickerShadowIngestPlan',
      'formatStickerShadowIngestDiagnostic', 'loadStickerShadowSeedIndex',
      'buildStickerShadowSendPlan', 'formatStickerShadowSendDiagnostic',
      'getStickerShadowLogFile', 'buildStickerShadowLogEvent',
      'appendStickerShadowLog',
    ],
    diagnostics: [
      'logReplyTimingDiagnostic', 'logAffectRouterDiagnostic',
      'buildAffectRouterDiagnosticForShadow', 'logAffectRouterDiagnosticForOutputShadow',
      'logStickerShadowPlan', 'logStickerShadowIngestDiagnostic', 'logStickerShadowSendDiagnostic',
    ],
    groupSceneIndex: [
      'appendGroupSceneEntry', 'loadGroupScenes', 'readGroupContext',
      'buildActiveGroupSceneNote', 'classifySceneItemsForActive', 'sanitizeSceneText', 'safeSceneChannelKey',
    ],
    randomReplyMode: [
      'parseRandomReplyDecision', 'buildRandomModePrompt', 'buildAmbientWaterSendOptions',
      'looksLikeRawInternalProtocol',
    ],
    resourceDirective: [
      'readResourceContext', 'directiveFromEntryPolicy', 'directiveFromAdmission',
      'decideEntryDirective', 'decideTaskDirective', 'admitTaskDirective', 'isDirectiveBlocking',
    ],
    backgroundDirective: [
      'getBackgroundDirectiveSleepMs', 'shouldParkBackgroundDirective', 'decideBackgroundDirective',
    ],
    resourceActivityLease: [
      'readResourceActivityLease', 'hasActiveResourceActivityLease',
      'findBlockingResourceActivityLease', 'buildResourceActivityLeaseBlockReason',
      'acquireResourceActivityLease',
    ],
    randomPersonaRisk: [
      'getGroupPersonaName', 'isPersonaSwitchRisky',
    ],
    sessionCompat: [
      'patchElementText', 'patchElementsToText', 'patchElementId',
      'patchStripNickname', 'patchBuildStripped', 'patchInstallAccessors',
      'patchEnsureSession', 'installSessionCompatibility',
    ],
    botResolver: [
      'resolveCurrentBot', 'createBotResolver', 'withCurrentBot',
    ],
    channelTaskQueue: [
      'enqueueForChannel', 'clearChannelQueues',
    ],
    eventDump: [
      'getArmedEventDump', 'armEventDump', 'clearArmedEventDump', 'dumpSessionEvent',
    ],
    startupSchedulers: [
      'getNextShanghaiMidnightDelayMs', 'scheduleDailyStatsCleanup',
      'clearStartupSchedulers',
    ],
    pluginLifecycle: [
      'restoreTodayCacheEntry', 'restoreTodayCache', 'registerPluginLifecycle',
    ],
    messageSegment: [
      'decodeEntityAttribute', 'extractAttrValue', 'extractCqAttrValue',
      'extractImageRefFromContent', 'appendUniqueSegments', 'getMessageSegments',
      'normalizeSegmentData', 'extractFileRefFromContent', 'getFileSegmentData',
    ],
    incomingFile: [
      'cacheSmallFileBackground',
    ],
    incomingMessageFlow: [
      'handleIncomingMessageArtifacts',
    ],
    sharedRecordText: [
      'resolveSharedRecordText',
    ],
    fileQuickRead: [
      'isFileQuickReadIntent', 'resolveFileQuickReadReply',
    ],
    runtimeSettings: [
      'loadRuntimeSettings', 'getRandomTriggerBaseRate', 'getRandomWhitelistStatus',
      'getFileFingerprint',
    ],
    userBlacklist: [
      'loadUserBlacklist', 'setBlacklistFingerprint',
    ],
    safeSend: [
      'logStaleRandomSkip', 'safeSendRepeat', 'safeSendReply',
      'safeSendRareVoice', 'resetSendFailState',
    ],
    randomState: [
      'getRandomMissCount', 'setRandomMissCount',
      'incrementRandomMiss', 'resetRandomMiss', 'getRandomTriggerRate',
      'isRandomCooldownActive', 'markRandomReplySent', 'getRandomMuteRemaining',
      'muteRandomChannel', 'isRandomMuted', 'getChannelMessageVersion',
      'bumpChannelMessageVersion', 'getExplicitInteractionVersion',
      'bumpExplicitInteractionVersion', 'trimRandomChannelState',
      'getPendingRandom', 'setPendingRandom', 'takePendingRandom',
      'cancelPendingRandom', 'clearRandomPendingState',
      'buildRandomSendOptions', 'isRandomReplyFresh', 'isSafeSendReplyFresh',
    ],
    api: [
      'requestChatCompletions', 'normalizeMessagesForProvider', 'buildFallbackConfig', 'getFallbackSteps',
      'buildResponsesInput', 'extractResponsesText', 'requestOpenAIResponsesWithSearch',
      'isVisionModel', 'callGetImage', 'callGetForwardMsg', 'sendForwardMsg', 'getGroupMemberInfo', 'getGroupInfo', 'readImageAsBase64',
      'downloadImageAsBase64', 'extractImageFileFromElements',
    ],
    conversation: [
      'getConversationKey', 'getChannelKey', 'touchConversation',
      'readConversationDisk', 'writeConversationDisk', 'getConversationHistory',
      'saveConversationTurn', 'mergeConversationMessages', 'generateConversationSummary', 'saveSharedChannelTurn',
      'saveUserProfile', 'saveSensitiveCache', 'analyzeChannelSensitive',
      'clearConversationHistory', 'clearUserConversationHistory',
      'getReplyFingerprintHistory', 'saveReplyFingerprint', 'getRecentAssistantReplies',
      'getRecentUserMessages', 'parseUserMessageEnvelope', 'getUserMessageContent',
      'normalizeUserMessageForPrompt', 'findChannelMessageById', 'flushTodayCacheToDisk', 'collectReplyChain',
      'getQuoteContentText', 'getQuoteInfo',
      'getQuotedMessageNote', 'getSharedContextNote',
      'writeMemory', 'deleteMemory', 'clearUserMemory', 'clearGroupMemory', 'getMemorySummary',
      'readMemoryTimer', 'checkMemoryTimerExpired',
    ],
    commandResult: [
      'handled', 'notHandled',
    ],
    voiceCommand: [
      'handleVoiceCommand',
    ],
    memoryCommand: [
      'handleMemoryCommand',
    ],
    planCommand: [
      'handlePlanCommand',
    ],
    agentCommand: [
      'handleAgentCommand',
    ],
    emotionCommand: [
      'handleEmotionCommand',
    ],
    chat: [
      'chat', 'loadConfig', 'resetConfigCache', 'loadSkills',
      'loadSkillsContentCache', 'refreshSkillsContentCacheIfChanged',
      'callOpenAI', 'getThinkingArgs',
      'getSkillsCount', 'getThinkingEnabled', 'setThinkingEnabled',
    ],
    chatPromptBuilder: [
      'testChatPromptRegex',
      'createChatPromptBaseMessages',
      'createChatPromptNsfwMessage',
      'resolveChatPromptPersonaLore',
      'createChatPromptLoreMessage',
      'createChatPromptSearchRuleMessage',
      'createChatPromptRandomContextMessage',
      'createChatPromptForwardSummaryMessage',
      'createChatPromptShortFollowUpMessage',
      'createChatPromptGenerationRequestMessage',
      'createChatPromptRareContextMessage',
      'createChatPromptConversationSummaryMessage',
      'createChatPromptMemoryMessage',
      'createChatPromptHistoryBackgroundMessage',
      'createChatPromptSeriousQuestionMessage',
      'createChatPromptUncertainQuestionMessage',
      'createChatPromptPoliticalSensitiveMessage',
      'createChatPromptHostileEvaluationMessage',
      'createChatPromptPlainUserMessage',
    ],
    chatToolFlow: [
      'updateChatToolUsageState', 'buildQqChatToolContext', 'handleChatToolFlow',
    ],
    chatFinalOutputFlow: [
      'getReplyMaxChars', 'retryUnsafeReply', 'finalizeChatReply',
    ],
    chatJailbreakFlow: [
      'isContextJailbroken', 'chatJailbreak',
    ],
    chatTopicSwitch: [
      'detectTopicSwitch', 'resolveTopicSwitch', 'clearTopicSwitchLocks',
    ],
    chatAgentRetellFlow: [
      'getAgentReplyMaxChars', 'retellAgentResultForChat',
    ],
    chatResultFlow: [
      'normalizeChatResultText', 'retellToolBlockedReply', 'retellAgentResult', 'handleChatResult',
    ],
    chatSendFlow: [
      'sendChatReplyFlow',
    ],
    agentAutoRouteFlow: [
      'handleAgentAutoRoute',
    ],
    agentChatBridge: [
      'buildAgentContextKey', 'summarizeAgentToolResults', 'extractSearchSummary',
      'recordAgentChatResult', 'getRecentAgentContextNote', 'clearAgentChatBridge',
    ],
    agentRetellGuard: [
      'collectAgentMaterial', 'hasSearchFailureMaterial', 'replyAcknowledgesSearchFailure',
      'buildSearchFailureRetellFallback', 'shouldFilterAgentMaterialLine', 'redactAgentMaterial', 'guardAgentRetellReply',
    ],
    resultNotifier: [
      'buildAgentTaskTextMessage', 'hasHardSearchFailureSignal', 'isChatHeavyToolTask', 'hasAgentSendableText', 'createAgentTaskSender',
    ],
    jailbreakRuleset: [
      'combinePatterns',
    ],
    loggingConfig: [
      'normalizeDebugLogConfig', 'readDebugLogConfig', 'writeDebugLogConfig',
      'isDebugLogEnabled', 'logDebug',
    ],
    runtimeConfig: [
      'loadConfig', 'resetConfigCache', 'getThinkingArgs',
      'getAdminUserIds', 'isAdminUserId',
      'getThinkingEnabled', 'setThinkingEnabled',
    ],
    reply: [
      'loadStickerCache', 'sendReply',
    ],
    replyGuard: [
      'shouldRetryRepeatedReply', 'buildRepeatRetryPrompt',
      'pickAbusiveFallbackReply', 'pickRepeatedFallbackReply',
      'isConsecutiveUserRepeat', 'isUnsafeThinkingReply',
      'stripStickerMarkersForGuard',
      'detectOldMediaTopicSticking', 'buildOldMediaStickingRetryPrompt',
    ],
    repeat: [
      'loadRepeatConfig', 'setRepeatEnabled', 'getRepeatEnabledCache',
      'buildRepeatCandidate', 'checkGroupRepeat',
    ],
    forward: [
      'resolveForwardSummary',
    ],
    vision: [
      'markSessionForVision', 'isVisionSession', 'getVisionPayload',
      'clearVisionSession', 'prepareVisionRequest', 'appendVisionMessage',
      'isVisionBlindnessReply', 'downgradeVisionMessageToText',
    ],
    sensitive: [
      'getPoliticalDetectList', 'resetPoliticalDetectCache',
      'clearSensitiveRuntimeState', 'notifySensitiveHandlers',
      'handleSensitiveMessage',
    ],
    healthCheck: [
      'runHealthCheck', 'formatHealthReport', 'resetHealthCache',
    ],
    retaliation: [
      'calculateRetaliationScore',
    ],
    sendGuard: [
      'classifySendError', 'sanitizeForRateLimit', 'computeBackoffMs',
      'sleepForRateLimitRetry', 'getSendChannelKey', 'getCachedPlatformMuteStatus',
      'markPlatformMute', 'clearPlatformMute', 'checkPlatformMuteStatus',
    ],
    rareVoice: [
      'shouldTriggerRareVoice', 'readRareVoiceAudioBuffer', 'resolveRareVoiceSource', 'prepareRareVoiceWav',
    ],
    agentEngine: [
      'run', 'resumePending', 'normalizeContextPolicy', 'applyContextPolicyToTools',
    ],
    agentMessages: [
      'buildAgentMessages', 'sanitizeAgentHistory',
    ],
    agentConfig: [
      'getAgentConfig', 'saveAgentConfig', 'patchAgentConfig', 'setChannelEnabled', 'setToolEnabled',
      'isChannelEnabled', 'isToolEnabled', 'getReadFileRoots', 'getDangerousPolicy', 'isAutoRouteEnabled', 'getEnabledSkills', 'getAgentPersonaConfig', 'resetAgentConfigCache',
    ],
    agentContext: [
      'estimateTokens', 'truncateToolResult', 'externalizeToolResult', 'buildContextReport', 'compactMessages', 'compactOldToolResults', 'summarizeToolResult', 'estimateCacheHitRate',
      'buildStructuredSummaryPrompt', 'mergeSummaryIntoMessages', 'compactWithLLM',
    ],
    agentPersonaContext: [
      'buildAgentPersonaContext', 'buildAgentPersonaSystemMessage', 'mergeAgentSystemExtra', 'listAgentPersonasForConsole',
    ],
    agentWorkspaceContext: [
      'normalizeIntentText', 'normalizeRequestedPath', 'resolveAgentPathInput', 'getWorkspaceSemanticCandidates', 'formatWorkspaceContext', 'buildAgentWorkspaceContext',
    ],
    agentSearchQuery: [
      'cleanExplicitSearchQuery', 'buildSearchQueries', 'getDirectSearchCandidates', 'isWuwaLatestRoleQuery', 'isMinecraftUpdateQuery', 'isHotVideoQuery', 'isResourceVideoQuery', 'getSearchHostname', 'scoreSearchResult', 'isLowQualitySearchResult', 'sortSearchResults',
    ],
    agentSearchResults: [
      'normalizeResultUrl', 'normalizeSearchCandidate', 'isUsefulSearchResult', 'hasQuerySignal', 'getResultDomainSignal', 'rankSearchCandidates', 'formatSearchResults', 'buildSearchFailureText', 'classifySearchResult', 'extractRetryKeywords', 'detectFailurePattern', 'buildStrategyQueries',
    ],
    agentFetchReader: [
      'getFetchLimits', 'validatePublicHttpUrl', 'resolveAndValidateHostname', 'readResponseBytesLimited', 'extractTitle',
      'classifyCandidateText', 'readCandidatePage', 'fetchWithManualRedirect', 'fetchReadableUrl',
    ],
    agentHttpSearch: [
      'decodeHttpSearchEntities', 'stripHttpSearchTags', 'resolveHttpSearchUrl', 'extractHttpSearchCandidates',
      'extractHttpPageText', 'readHttpResultPage', 'fetchHttpResultPage', 'readTopResultPages', 'mergeHttpSearchCandidates', 'formatCandidateList', 'formatSearchWithPages', 'runHttpSearch', 'runSearchPass', 'buildRetryQueries',
    ],
    agentQueue: [
      'enqueueAgentTask', 'getAgentQueueStats', 'clearAgentQueue', 'configureAgentQueue', 'withTimeout', 'resetAgentQueueForTests',
    ],
    agentMemory: [
      'remember', 'searchMemory', 'forgetMemory', 'listMemory', 'formatMemoryItems', 'tokenize', 'safeUserId',
    ],
    chatTools: [
      'getChatToolDefinitions', 'resolveChatToolChannel', 'isChatToolAllowed',
      'isLightweightTool', 'isHeavyTool', 'executeChatTool', 'handleChatToolCalls', 'getChatToolSystemHint',
    ],
    chatToolPolicy: [
      'isLightweightTool', 'isHeavyTool', 'isRandomReplyBlockedTool', 'isExplicitChatWriteActionAllowed',
    ],
    agentAutoMemory: [
      'onAgentReplyComplete', 'resetAutoMemoryCounter', 'getAutoMemoryStats', 'shouldTrigger', 'getDailyTotalSize', 'safeUserId',
    ],
    agentPush: [
      'send', 'sendToAdmin', 'taskComplete', 'cronResult', 'getQuota', 'listPushLog', 'sendBotMessage',
    ],
    agentCron: [
      'loadCrons', 'saveCrons', 'registerCron', 'getCron', 'registerOnceTask', 'unregisterCron', 'updateCron', 'pauseCron', 'resumeCron', 'runCronNow', 'listCronHistory', 'startCronScheduler', 'stopCronScheduler', 'getNextRunAt', 'validateCronSchedule', 'parseCronField', 'cronMatches', 'appendHistory', 'createCronId',
    ],
    agentPlanStore: [
      'buildPlanId', 'safePlanId', 'normalizePlan', 'savePlan', 'loadPlan', 'listPlans', 'listActivePlans', 'getPlanStorageInfo',
    ],
    agentPlanEngine: [
      'createPlan', 'updateTaskStatus', 'checkPlanStatus', 'finishPlan', 'abandonPlan', 'formatPlan',
    ],
    agentPlanPrompts: [
      'buildPlanSystemPrompt', 'buildPlanCreatePrompt',
    ],
    agentPlanTools: [
    ],
    agentPlanRunner: [
      'resumePlan', 'resolvePlan', 'getActiveTask',
    ],
    agentPathGuard: [
      'isAgentPathInside', 'getAgentPathAllowedRoots', 'assertExistingAgentPathInsideRoots', 'assertNewAgentPathInsideRoots', 'assertNotWriteBlockedBasename', 'resolveAgentDefaultRoot',
    ],
    agentSkills: [
      'listAgentSkills', 'findAgentSkill', 'findRelevantAgentSkills', 'readAgentSkill', 'parseFrontmatter', 'buildAgentSkillSummary', 'stripFrontmatter',
    ],
    agentSkillHub: [
      'listSkillHubItems', 'findSkillHubItem', 'setSkillHubEnabled', 'formatSkillHubItems',
    ],
    agentSkillScanner: [
      'scanSkillDirectory', 'scanSkillFile', 'hashFileContent',
      'computeDirectoryHash', 'addToWhitelist', 'removeFromWhitelist',
    ],
    agentRouter: [
      'heuristicRoute', 'isExplicitSearchRequest', 'isExplicitUrlFetchRequest', 'isGeneralSearchIntent', 'isSearchFollowUpRequest', 'isSearchRefinementRequest', 'isPreviousSearchContextQuestion', 'hasSearchableRecentContext', 'pickRecentSearchContext', 'extractSingleUrl', 'buildContextualSearchQuery', 'buildSearchAgentUserMessage', 'buildExplicitSearchRunOptions', 'buildExplicitUrlFetchRunOptions', 'getStructuredSearchContext', 'canUseStructuredSearchContext', 'isStructuredSearchBlocked',
    ],
    agentWorkerSubmission: [
      'submitAgentWorkerTask', 'countActiveAgentWorkerTasks', 'formatAcceptedMessage',
    ],
    resourceTaskStore: [
      'ensureTaskDirs', 'writeWorkerEvent', 'createTaskId', 'submitResourceTask',
      'getResourceTaskById', 'getResourceTaskByIdForKind', 'findResourceTaskByKindAndChannel',
      'listResourceTasks', 'countResourceTasks',
      'countResourceTasksByKind', 'getTaskQueueSummary', 'claimNextTask',
      'claimTaskById', 'markTaskRunning', 'failIsolatedClaimingTask',
      'updateTaskStep', 'writeTaskResult', 'completeTask', 'failTask',
      'deferTask', 'requeueTask', 'updateTaskNotifyStatus', 'cancelTask',
      'writeWorkerHeartbeat', 'listWorkerStates', 'removeTaskFile',
      'registerTaskCompletedCallback', 'unregisterTaskCompletedCallback',
    ],
    searchContext: [
      'buildPrivateSearchContext', 'mergeSearchContext', 'hasConcreteSearchSubject', 'isPotentialSearchFollowUp',
    ],
    agentSessions: [
      'buildAgentSessionId', 'recordAgentSession', 'listAgentSessions', 'getAgentSession', 'clearAgentSessions',
    ],
    agentStats: [
      'recordCall', 'getStats',
    ],
    agentPending: [
      'getPendingTool', 'findPendingToolById', 'getPendingToolById', 'setPendingTool', 'clearPendingTool', 'clearPendingToolById', 'trimPendingTools', 'summarizePendingArgs', 'listPendingTools', 'executePendingTool', 'confirmPendingTool',
    ],
    agentSafety: [
      'getMode', 'setMode', 'getEffectivePolicy', 'check',
    ],
    agentToolRegistry: [
      'getToolDefinitions', 'executeTool', 'getToolCount', 'getToolSummaries',
    ],
    agentToolShellGuard: [
      'checkShellCommand', 'isCommandSafe', 'listShellGuardRules', 'summarizeShellCommand',
    ],
    agentToolReadAgentSkill: ['execute'],
    agentToolWebFetch: ['execute', 'normalizeFetchedText', 'checkWebFetchRateLimit', 'resetWebFetchRateLimitForTests'],
    agentToolMemoryTools: [],
    agentToolAppendFile: ['execute'],
    agentToolGrepSearch: ['execute'],
    agentToolExecuteJavascript: ['execute'],
    agentToolSendFileToUser: ['execute'],
    agentToolCreateUploadedFileVariant: ['execute', 'createVariant', 'resolveTargetFileName'],
    agentToolGetTokenUsage: ['execute'],
    agentToolSetUserTimezone: ['execute'],
    agentToolQueryLogs: ['execute'],
    agentToolCreateReminder: ['execute', 'resolveRunAt'],
    agentToolReminderTools: [
      'executeCreateReminder', 'executeListReminders', 'executeCancelReminder', 'resolveRunAt',
    ],
    agentToolScheduledTaskTools: [
      'executeCreateScheduledTask', 'executeListScheduledTasks', 'executeGetScheduledTask',
      'executePauseScheduledTask', 'executeResumeScheduledTask', 'executeDeleteScheduledTask',
      'executeRunScheduledTaskNow', 'resolveRunAt', 'resolveTarget',
    ],
    agentToolAnalyzeFile: ['execute'],
    voiceQuickRead: [
      'isVoiceQuickReadIntent', 'resolveVoiceQuickReadReply', 'formatVoiceQueuedReply',
    ],
    voice: [
      'extractVoicePayload', 'downloadVoiceFile', 'convertToWav', 'callModelAsr', 'transcribeVoice',
    ],
    tts: [
      'synthesizeSpeech', 'sendVoiceMessage', 'resolvePersonaVoice',
      'sanitizeTtsStyle', 'composeTtsStyle',
      'extractVoiceStyle', 'stripVoiceStyleTag', 'getBuiltinVoices',
      'isChannelOnCooldown', 'markChannelCooldown', 'shouldTriggerRandomVoice', 'getMimoriumKey',
      'detectAudioMime', 'getRandomVoiceRate',
    ],
    randomVoiceRate: [
      'normalizeVoiceRate', 'loadRandomVoiceRateCache', 'getRandomVoiceRate',
      'setRandomVoiceRate', 'resetRandomVoiceRate', 'shouldTriggerRandomVoiceByRate',
    ],
    voiceAssets: [
      'sanitizeVoiceAssetId', 'createVoiceAssetId', 'buildVoiceAssetFilename',
      'getAudioExtFromMime', 'getAudioMimeFromFilename',
      'listVoiceAssets', 'findVoiceAsset', 'listVoiceAssetReferences', 'upsertVoiceAsset',
      'updateVoiceAssetMetadata', 'deleteVoiceAsset', 'resolveVoiceSampleFile',
    ],
    imageStore: [
      'storeImageUrl', 'getImageEntry', 'getRecentImages', 'getRecentImagesCached', 'markAnalyzed',
      'markAnalysisUnavailable', 'storeAssistantImageAnchor',
      'isAlreadyAnalyzed', 'getCachedAnalysis', 'replaceImagePlaceholder',
      'cacheImageFile', 'readCachedImage', 'enforceChannelCacheLimit',
    ],
    imageAnalyzer: [
      'enqueueAnalysis',
    ],
    imageAnalysisSanitizer: [
      'sanitizeImageAnalysis', 'looksLikePersonaImageReply',
    ],
    publicManagementRuntime: [
      'loadManagementModule', 'listManagementModules',
    ],
  }
  for (const [moduleName, names] of Object.entries(expectedExports)) {
    const target = modules[moduleName]
    for (const name of names) {
      check(`${moduleName}.${name} exported`, typeof target[name] === 'function')
    }
  }
  check('onebotEndpoint.DEFAULT_ONEBOT_WS_URL exported', typeof modules.onebotEndpoint.DEFAULT_ONEBOT_WS_URL === 'string' && modules.onebotEndpoint.DEFAULT_ONEBOT_WS_URL.startsWith('ws://127.0.0.1:'))
  check('backgroundDirective exports sleep helper', typeof modules.backgroundDirective.getBackgroundDirectiveSleepMs === 'function')
  check('resourceActivityLease.ACTIVITY_ROOT exported', typeof modules.resourceActivityLease.ACTIVITY_ROOT === 'string' && modules.resourceActivityLease.ACTIVITY_ROOT.includes('resource-activity'))
  check('randomState.channelMissCount exported as Map', modules.randomState.channelMissCount instanceof Map)
  check('agentSkillScanner.SCAN_RULES exported', Array.isArray(modules.agentSkillScanner.SCAN_RULES) && modules.agentSkillScanner.SCAN_RULES.length > 0)
  check('agentSkillScanner.SEVERITY_ORDER exported', !!(modules.agentSkillScanner.SEVERITY_ORDER && typeof modules.agentSkillScanner.SEVERITY_ORDER === 'object'))
  check('persona profile source reader keeps bounded legacy file size', modules.personaProfileSources.MAX_PROFILE_SOURCE_FILE_BYTES === 512 * 1024)
  check('persona profile re-exports source reader helpers from dedicated source module', modules.personaProfile.safePersonaProfileFile === modules.personaProfileSources.safePersonaProfileFile && modules.personaProfile.readLegacyPersonaProfileData === modules.personaProfileSources.readLegacyPersonaProfileData)
  ;(() => {
    const kinds = modules.resourceTaskKinds || {}
    check('resourceTaskKinds exports task kind constants', kinds.RESOURCE_TASK_KIND && kinds.RESOURCE_TASK_KIND.MEDIA_IMAGE_ANALYSIS === 'media_image_analysis' && kinds.RESOURCE_TASK_KIND.DAILY_REPORT === 'daily_report')
    check('resourceTaskKinds classifies media task kinds', kinds.isMediaTaskKind && kinds.isMediaTaskKind('media_image_analysis') && kinds.isMediaTaskKind('media_file_analysis') && kinds.isMediaTaskKind('media_voice_transcription') && !kinds.isMediaTaskKind('daily_report'))
    check('resourceTaskKinds classifies scheduler special kinds', kinds.isStatusQueryKind && kinds.isStatusQueryKind('status_query') && kinds.isNormalChatKind('normal_chat') && kinds.isDailyReportKind('daily_report_render') && !kinds.isDailyReportKind('daily_summary'))
    check('resourceTaskKinds classifies chromium task kinds', kinds.isChromiumTaskKind && kinds.isChromiumTaskKind('browser_action') && kinds.isChromiumTaskKind('daily_report_render') && !kinds.isChromiumTaskKind('daily_report'))
  })()
  checkEqual('AI plugin name', index.name, 'dongxuelian-ai')
  check('AI plugin does not export _testOnly', index._testOnly === undefined)
  check('handler.handleCommand exported', typeof handler.handleCommand === 'function')
  check('repeat candidate builder exported', typeof index.buildRepeatCandidate === 'function')
  check('repeat checker exported', typeof index.checkGroupRepeat === 'function')
  check('vision session key list exported', Array.isArray(modules.vision.VISION_SESSION_KEYS) && modules.vision.VISION_SESSION_KEYS.length === 3)
  check('jailbreak pattern groups exported', modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERN_GROUPS && typeof modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERN_GROUPS === 'object')
  check('jailbreak pattern list exported', Array.isArray(modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERNS) && modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERNS.length > 0)
  check('jailbreak combined regexp exported', modules.jailbreakRuleset.JAILBREAK_INPUT_RE instanceof RegExp)
  check('jailbreak input patterns owned by core constants', c.JAILBREAK_INPUT_PATTERN_GROUPS === modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERN_GROUPS && c.JAILBREAK_INPUT_PATTERNS === modules.jailbreakRuleset.JAILBREAK_INPUT_PATTERNS && c.JAILBREAK_INPUT_RE === modules.jailbreakRuleset.JAILBREAK_INPUT_RE)
  const sanitizedSceneText = modules.groupSceneIndex.sanitizeSceneText('看看 file://D:/qq/private/a.png https://secret.example/path token=abc123')
  check('group scene sanitizes file URL', !sanitizedSceneText.includes('file://') && sanitizedSceneText.includes('[本地文件]'), sanitizedSceneText)
  check('group scene sanitizes http URL', !sanitizedSceneText.includes('https://secret.example'), sanitizedSceneText)
  check('group scene sanitizes token value', !sanitizedSceneText.includes('abc123'), sanitizedSceneText)
  const bearerSceneText = modules.groupSceneIndex.sanitizeSceneText('Authorization: Bearer abcdef1234567890 url=https://example.com/a?signature=abc&token=xyz')
  check('group scene sanitizes bearer and url params', !bearerSceneText.includes('abcdef1234567890') && !bearerSceneText.includes('signature=abc') && !bearerSceneText.includes('token=xyz') && !bearerSceneText.includes('$1='), bearerSceneText)
  const spacedLocalPath = modules.groupSceneIndex.sanitizeSceneText('图在 file://D:/qq/我的 文档/nt_data/Pic/a b.jpeg 和 D:\\qq\\我的 文档\\secret.png')
  check('group scene sanitizes local paths with spaces', !spacedLocalPath.includes('D:/qq') && !spacedLocalPath.includes('D:\\qq') && !spacedLocalPath.includes('secret.png') && spacedLocalPath.includes('[本地文件]') && spacedLocalPath.includes('[本地路径]'), spacedLocalPath)
  const ambientDecision = modules.randomReplyMode.parseRandomReplyDecision('{"mode":"ambient_water","reply":"先看一眼怎么收场"}')
  check('random reply mode parses ambient JSON internally', ambientDecision.shouldSend && ambientDecision.mode === 'ambient_water' && ambientDecision.reply.includes('先看一眼'), JSON.stringify(ambientDecision))
  const rawJsonDecision = modules.randomReplyMode.parseRandomReplyDecision('{"mode":"ambient_water"}')
  check('random reply mode blocks structured empty reply', !rawJsonDecision.shouldSend && rawJsonDecision.reason === 'structured-empty-reply', JSON.stringify(rawJsonDecision))
  check('random reply mode detects raw protocol', modules.randomReplyMode.looksLikeRawInternalProtocol('{"mode":"no_send","reply":""}'))
  const ambientOptions = modules.randomReplyMode.buildAmbientWaterSendOptions({ forceQuote: true, quoteMessageId: 'm1' })
  check('ambient water send options disable quote', ambientOptions.noQuote === true && ambientOptions.forceQuote === false && ambientOptions.quoteMessageId === '', JSON.stringify(ambientOptions))
  check('runtime settings caches exported with stable container types', modules.runtimeSettings.randomWhitelistCache instanceof Set && modules.runtimeSettings.randomRateCache instanceof Map)
  check('agent plan tools array exported', Array.isArray(modules.agentPlanTools.tools) && modules.agentPlanTools.tools.length >= 5)
  check('agent memory tools array exported', Array.isArray(modules.agentToolMemoryTools.tools) && modules.agentToolMemoryTools.tools.length >= 4)
  for (const toolModuleName of ['agentToolTime', 'agentToolCalculator', 'agentToolWebSearch', 'agentToolWebFetch', 'agentToolReadFile', 'agentToolListFiles', 'agentToolFindFiles', 'agentToolWriteFile', 'agentToolEditFile', 'agentToolShell', 'agentToolBrowserAction', 'agentToolAppendFile', 'agentToolGrepSearch', 'agentToolExecuteJavascript', 'agentToolSendFileToUser', 'agentToolGetTokenUsage', 'agentToolSetUserTimezone', 'agentToolQueryLogs', 'agentToolAnalyzeFile']) {
    const tool = modules[toolModuleName]
    check(`${toolModuleName}.definition exported`, !!(tool && tool.definition && typeof tool.definition.name === 'string'))
    check(`${toolModuleName}.execute exported`, typeof tool.execute === 'function')
    check(`${toolModuleName}.defaultChannels exported`, Array.isArray(tool.defaultChannels))
  }
  check('browser action URL guard rejects private hosts', modules.agentToolBrowserAction.isPrivateHostname('localhost') && modules.agentToolBrowserAction.isPrivateIp('127.0.0.1') && modules.agentToolBrowserAction.isPrivateIp('169.254.169.254'))
  check('browser action URL guard reuses core helper identity', modules.agentToolBrowserAction.isPrivateHostname === modules.utils.isPrivateHostname && modules.agentToolBrowserAction.isPrivateIp === modules.utils.isPrivateIp)
  await modules.agentToolBrowserAction.validateUrl('https://example.com/path?signature=public-test').then(
    value => check('browser action URL guard allows public URL', value.startsWith('https://example.com/'), value),
    error => check('browser action URL guard allows public URL', false, error.message)
  )
  await modules.agentToolBrowserAction.validateUrl('http://127.0.0.1/admin').then(
    value => check('browser action URL guard rejects localhost URL', false, value),
    error => check('browser action URL guard rejects localhost URL', /拒绝访问/.test(error.message), error.message)
  )

  return { modules, c, u, p, api, conv, reader, handler, index }
}

module.exports = { runModuleContract }
