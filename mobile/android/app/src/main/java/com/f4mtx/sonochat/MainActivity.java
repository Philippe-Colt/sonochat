package com.f4mtx.sonochat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local (pas de paquet npm) : à enregistrer avant super.onCreate
        registerPlugin(UsbSerialPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
