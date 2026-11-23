package online.zienorganisation.call;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that runs while a Zien Call call is active.
 *
 * Android stops microphone/camera access and suspends network activity for apps in the
 * background. A foreground service of type "microphone" (plus "camera" for video calls)
 * with an ongoing notification keeps the call running when the user switches apps or
 * turns the screen off. Built by Zien Technologies.
 */
public class CallService extends Service {
    static final String ACTION_START = "online.zienorganisation.call.action.START";
    static final String ACTION_HANGUP = "online.zienorganisation.call.action.HANGUP";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_VIDEO = "video";

    private static final String TAG = "ZienCallService";
    private static final String CHANNEL_ID = "zien_call_ongoing";
    private static final int NOTIFICATION_ID = 4514;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_HANGUP.equals(action)) {
            CallServicePlugin.emitHangup();
            shutdown();
            return START_NOT_STICKY;
        }

        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        if (title == null || title.isEmpty()) title = "Call";

        createChannel();
        Notification notification = buildNotification(title, video);

        int types = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video && granted(Manifest.permission.CAMERA)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (types == 0) {
                Log.w(TAG, "No microphone permission; not starting call service");
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types);
        } catch (Exception e) {
            Log.w(TAG, "startForeground with types " + types + " failed: " + e);
            try {
                int micOnly = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, micOnly);
            } catch (Exception e2) {
                Log.e(TAG, "Could not start foreground call service", e2);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away from recents: the web view is gone, so the call is over.
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        super.onDestroy();
    }

    private void shutdown() {
        releaseLocks();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // Default importance so the call shows at the top with its Hang up button, but no sound/vibration.
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Shown while a Zien Call call is running so it keeps going in the background");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        nm.deleteNotificationChannel("zien_call_active");   // channel used by v1.1 builds
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String title, boolean video) {
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;

        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, immutable | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent hangup = new Intent(this, CallService.class).setAction(ACTION_HANGUP);
        PendingIntent hangupPi = PendingIntent.getService(this, 1, hangup, immutable | PendingIntent.FLAG_UPDATE_CURRENT);

        Person caller = new Person.Builder().setName((video ? "Video call · " : "Call · ") + title).setImportant(true).build();
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_zien_logo)
            .setColor(0xFF5B4FF0)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangupPi))   // big red "Hang up" button
            .setContentTitle((video ? "Video call · " : "Call · ") + title)
            .setContentText("Zien Call is running in the background. Tap to return.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openPi)
            .build();
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ZienCall:call");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(4 * 60 * 60 * 1000L); // safety cap: 4 h

            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "ZienCall:call");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } catch (Exception e) {
            Log.w(TAG, "Could not take wake/wifi lock: " + e);
        }
    }

    private void releaseLocks() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) { }
    }
}
