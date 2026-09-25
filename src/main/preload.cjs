/**
 * 预加载脚本：向渲染层暴露最小化的受控 API。
 *
 * 安全约束：
 *  - `contextIsolation: true` + `nodeIntegration: false`；
 *  - 只暴露下面这几个具名方法，不透传 `ipcRenderer` 本身，
 *    渲染层无法构造任意通道消息；
 *  - 通道名写死在此文件，渲染层的 `invoke` 参数都会做类型校验。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 订阅主进程推送的歌词状态。
 *
 * @param {(state: object) => void} callback 状态回调
 * @returns {() => void} 取消订阅
 */
function onState(callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, state) => {
    try {
      callback(state);
    } catch (error) {
      // 渲染层回调异常不应影响 IPC 管道
      console.error('[preload] onState 回调异常:', error && error.message);
    }
  };
  ipcRenderer.on('hdl:state', listener);
  return () => ipcRenderer.removeListener('hdl:state', listener);
}

contextBridge.exposeInMainWorld('hdl', {
  /** 渲染层就绪握手：主进程收到后才开始推送状态。 */
  ready: () => ipcRenderer.invoke('hdl:ready'),

  /** 读取服务端与会话诊断信息。 */
  stats: () => ipcRenderer.invoke('hdl:stats'),

  /**
   * 请求调整窗口高度。
   *
   * @param {number} height 像素高度
   * @returns {Promise<boolean>} 是否生效
   */
  setHeight: (height) => ipcRenderer.invoke('hdl:setHeight', Number(height)),

  /** 隐藏窗口（最小化到托盘）。 */
  minimize: () => ipcRenderer.invoke('hdl:minimize'),

  /**
   * 开关鼠标穿透。
   *
   * @param {boolean} enabled 是否穿透
   * @returns {Promise<boolean>} 生效后的状态
   */
  setClickThrough: (enabled) => ipcRenderer.invoke('hdl:setClickThrough', Boolean(enabled)),

  /** 退出应用。 */
  quit: () => ipcRenderer.invoke('hdl:quit'),

  /**
   * 回传播放控制指令。
   *
   * @param {'play'|'pause'|'next'|'prev'} command 指令
   * @returns {Promise<number>} 实际送达的连接数
   */
  command: (command) => ipcRenderer.invoke('hdl:command', String(command)),

  /** 订阅歌词状态推送。 */
  onState,
});
