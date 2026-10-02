/**
 * Port série USB natif (application Android) : adaptateur entre le plugin
 * Capacitor « UsbSerial » (mobile/android/.../UsbSerialPlugin.java) et le modem.
 *
 * Dans le navigateur, le PTT passe par Web Serial : FT8Modem appelle
 * serialPort.setSignals({requestToSend, dataTerminalReady}). Chrome Android ne
 * gère pas le série USB filaire, d'où l'application : NativePttPort expose la
 * même interface que le SerialPort de Web Serial, le modem ne voit pas la différence.
 */

/** Plugin natif, ou null hors de l'application Android. */
function nativeUsbSerial() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : null;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  if (cap.registerPlugin) return cap.registerPlugin('UsbSerial');
  return (cap.Plugins && cap.Plugins.UsbSerial) || null;
}

class NativePttPort {
  /**
   * @param {object} plugin  plugin UsbSerial (list/open/setSignals/close)
   * @param {{deviceId: number, name: string}} info  port ouvert
   */
  constructor(plugin, info) {
    this.plugin = plugin;
    this.info = info;
  }

  /** Même signature que SerialPort.setSignals de Web Serial. */
  async setSignals(signals) {
    const native = {};
    if ('requestToSend' in signals) native.rts = !!signals.requestToSend;
    if ('dataTerminalReady' in signals) native.dtr = !!signals.dataTerminalReady;
    await this.plugin.setSignals(native);
  }

  async close() {
    await this.plugin.close();
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { NativePttPort, nativeUsbSerial };
}
