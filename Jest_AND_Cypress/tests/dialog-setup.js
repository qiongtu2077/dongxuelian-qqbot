// 模拟 jsdom 缺少的原生对话框接口；焦点和遮罩另由真实浏览器覆盖。
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
}
