/**
 * Electron 打包部署器：preload 可把桥接到 window.dongxuelianExpose.dongxuelianDeployer；
 * 兼容历史上直接挂在 window.dongxuelianDeployer 的产物。
 */

export function getDongxuelianDeployerBridge() {
  if (typeof window === 'undefined') return null
  return window.dongxuelianExpose?.dongxuelianDeployer || window.dongxuelianDeployer || null
}

export function isElectronDeployerEnv() {
  return !!getDongxuelianDeployerBridge()
}
