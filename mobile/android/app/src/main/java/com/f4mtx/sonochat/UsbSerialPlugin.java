package com.f4mtx.sonochat;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

import java.util.List;

/**
 * Port série USB pour le PTT de ChatMTX (côté JS : native-serial.js).
 *
 * Chrome Android ne gère pas le série USB filaire (Web Serial n'y fonctionne
 * qu'en Bluetooth) : ce plugin actionne RTS/DTR d'une interface USB-série
 * (Digirig Mobile, CP210x/FTDI/CH34x/PL2303/CDC, postes à USB intégré), qui
 * ferme le contact PTT-masse du poste.
 *
 * Sécurité : le poste ne doit jamais rester bloqué en émission. Les lignes
 * reviennent au repos (niveaux donnés à open) au débranchement, à la
 * destruction de l'activité, et par un minuteur si le PTT reste fermé plus
 * longtemps que la plus longue émission possible.
 */
@CapacitorPlugin(name = "UsbSerial")
public class UsbSerialPlugin extends Plugin {

    private static final String TAG = "SonoChatUsb";
    private static final String ACTION_PERMISSION = "com.f4mtx.sonochat.USB_PERMISSION";
    /** Trame étendue de 10 blocs ≈ 116 s : au-delà, c'est un PTT oublié. */
    private static final long WATCHDOG_MS = 130_000;

    private UsbManager usbManager;
    private UsbSerialPort port;
    private UsbDevice device;
    private boolean idleRts = false;
    private boolean idleDtr = false;
    private boolean rts = false;
    private boolean dtr = false;
    private PluginCall pendingOpen;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable watchdog = () -> {
        Log.w(TAG, "PTT ferme depuis trop longtemps : relache");
        applyIdle();
        notifyListeners("watchdog", new JSObject());
    };

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (ACTION_PERMISSION.equals(action)) {
                onPermissionResult(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice gone = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice.class);
                if (device != null && gone != null && gone.getDeviceId() == device.getDeviceId()) {
                    closePort();
                    notifyListeners("detached", new JSObject());
                }
            }
        }
    };

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        closePort();
        try {
            getContext().unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
        }
    }

    private List<UsbSerialDriver> drivers() {
        return UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray ports = new JSArray();
        for (UsbSerialDriver d : drivers()) {
            UsbDevice dev = d.getDevice();
            JSObject o = new JSObject();
            o.put("deviceId", dev.getDeviceId());
            o.put("vendorId", dev.getVendorId());
            o.put("productId", dev.getProductId());
            String product = dev.getProductName();
            o.put("name", product != null && !product.isEmpty() ? product : d.getClass().getSimpleName().replace("SerialDriver", ""));
            ports.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("ports", ports);
        call.resolve(ret);
    }

    /** open({deviceId, rts?, dtr?}) : rts/dtr = niveaux de repos (PTT relâché). */
    @PluginMethod
    public void open(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        UsbSerialDriver driver = null;
        for (UsbSerialDriver d : drivers()) {
            if (deviceId != null && d.getDevice().getDeviceId() == deviceId) driver = d;
        }
        if (driver == null) {
            call.reject("Interface USB introuvable");
            return;
        }
        idleRts = Boolean.TRUE.equals(call.getBoolean("rts", false));
        idleDtr = Boolean.TRUE.equals(call.getBoolean("dtr", false));
        if (usbManager.hasPermission(driver.getDevice())) {
            doOpen(call, driver);
            return;
        }
        // Demande d'autorisation : la réponse arrive dans le BroadcastReceiver
        pendingOpen = call;
        call.setKeepAlive(true);
        Intent intent = new Intent(ACTION_PERMISSION).setPackage(getContext().getPackageName());
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent pi = PendingIntent.getBroadcast(getContext(), 0, intent, flags);
        usbManager.requestPermission(driver.getDevice(), pi);
    }

    private void onPermissionResult(boolean granted) {
        PluginCall call = pendingOpen;
        pendingOpen = null;
        if (call == null) return;
        call.setKeepAlive(false);
        if (!granted) {
            call.reject("Autorisation USB refusee (permission)");
            return;
        }
        Integer deviceId = call.getInt("deviceId");
        for (UsbSerialDriver d : drivers()) {
            if (deviceId != null && d.getDevice().getDeviceId() == deviceId) {
                doOpen(call, d);
                return;
            }
        }
        call.reject("Interface USB introuvable");
    }

    private void doOpen(PluginCall call, UsbSerialDriver driver) {
        closePort();
        UsbDeviceConnection connection = usbManager.openDevice(driver.getDevice());
        if (connection == null) {
            call.reject("Ouverture USB impossible");
            return;
        }
        try {
            UsbSerialPort p = driver.getPorts().get(0);
            p.open(connection);
            p.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            port = p;
            device = driver.getDevice();
            applyIdle();
            JSObject ret = new JSObject();
            ret.put("deviceId", device.getDeviceId());
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "open", e);
            closePort();
            call.reject("Ouverture USB impossible : " + e.getMessage());
        }
    }

    @PluginMethod
    public void setSignals(PluginCall call) {
        if (port == null) {
            call.reject("Port USB ferme");
            return;
        }
        try {
            if (call.getData().has("rts")) {
                rts = Boolean.TRUE.equals(call.getBoolean("rts"));
                port.setRTS(rts);
            }
            if (call.getData().has("dtr")) {
                dtr = Boolean.TRUE.equals(call.getBoolean("dtr"));
                port.setDTR(dtr);
            }
            armWatchdog();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "setSignals", e);
            call.reject("Commande PTT impossible : " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        closePort();
        call.resolve();
    }

    /** Minuteur armé tant qu'une ligne est hors repos (PTT fermé). */
    private void armWatchdog() {
        handler.removeCallbacks(watchdog);
        if (rts != idleRts || dtr != idleDtr) handler.postDelayed(watchdog, WATCHDOG_MS);
    }

    private void applyIdle() {
        handler.removeCallbacks(watchdog);
        if (port == null) return;
        try {
            port.setRTS(idleRts);
            port.setDTR(idleDtr);
            rts = idleRts;
            dtr = idleDtr;
        } catch (Exception e) {
            Log.w(TAG, "applyIdle", e);
        }
    }

    private void closePort() {
        applyIdle();
        if (port != null) {
            try {
                port.close();
            } catch (Exception ignored) {
            }
        }
        port = null;
        device = null;
    }
}
