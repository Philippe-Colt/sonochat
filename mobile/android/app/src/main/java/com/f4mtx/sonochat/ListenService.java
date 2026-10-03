package com.f4mtx.sonochat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Service au premier plan pendant l'écoute (type « microphone ») : depuis Android 9, une
 * application qui passe en arrière-plan (assistant vocal ouvert par-dessus, autre appli,
 * écran éteint) reçoit du silence du micro. Ce service, démarré quand l'écoute commence
 * (appli au premier plan), garde l'accès au micro et le processeur éveillé (verrou partiel)
 * jusqu'à l'arrêt de l'écoute. L'assistant reste prioritaire pendant qu'il écoute lui-même :
 * l'application le détecte et reprend la capture ensuite (app.js, surveillance du micro).
 */
public class ListenService extends Service {
    private static final String CHANNEL = "ecoute";
    private static final int NOTIF_ID = 1;
    private PowerManager.WakeLock wakeLock;

    static void start(Context ctx) {
        Intent i = new Intent(ctx, ListenService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ListenService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Écoute radio", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Affichée tant que ChatMTX écoute le micro");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle("ChatMTX écoute")
                .setContentText("Réception des messages en cours (micro réservé)")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pi)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
        } catch (Exception e) {
            // Démarrage refusé (appli plus au premier plan, permission micro absente) : rien de mieux à faire
            stopSelf();
            return START_NOT_STICKY;
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chatmtx:ecoute");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(12 * 60 * 60 * 1000L); // filet : 12 h au plus
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
