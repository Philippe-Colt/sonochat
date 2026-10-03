package com.f4mtx.sonochat;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local (pas de paquet npm) : à enregistrer avant super.onCreate
        registerPlugin(UsbSerialPlugin.class);
        registerPlugin(ListenPlugin.class);
        super.onCreate(savedInstanceState);
        // Jamais de mise en veille tant que ChatMTX est ouvert (réception, alertes)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
