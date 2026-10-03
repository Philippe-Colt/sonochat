package com.f4mtx.sonochat;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** « ListenService » côté JS : start() quand l'écoute commence, stop() quand elle s'arrête. */
@CapacitorPlugin(name = "ListenService")
public class ListenPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+ : sans cette autorisation la notification est cachée (le service tourne quand même)
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711);
        }
        try {
            ListenService.start(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("Service d'écoute impossible : " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ListenService.stop(getContext());
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        ListenService.stop(getContext());
    }
}
