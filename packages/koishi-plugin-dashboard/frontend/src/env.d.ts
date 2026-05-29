interface DongxuelianDeployerBridge {
  getAppInfo?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  chooseDirectory?: () => Promise<string> | string
  selectDirectory?: (initialPath?: string) => Promise<string> | string
  openPath?: (targetPath: string) => Promise<unknown> | unknown
  showItemInFolder?: (targetPath: string) => Promise<unknown> | unknown
  copyText?: (text: string) => Promise<unknown> | unknown
  platform?: string
  [key: string]: unknown
}

interface Window {
  dongxuelianExpose?: {
    dongxuelianDeployer?: DongxuelianDeployerBridge
  }
  dongxuelianDeployer?: DongxuelianDeployerBridge
}
