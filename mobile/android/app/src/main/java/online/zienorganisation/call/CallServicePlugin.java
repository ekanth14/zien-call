package online.zienorganisation.call;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for {@link CallService}. The web app calls:
 *   Capacitor.nativePromise('CallService', 'start', { title, video })  when a call connects
 *   Capacitor.nativePromise('CallService', 'stop')                     when the call ends
 * and listens for the "hangup" event fired by the notification's "Leave call" button.
 */
@CapacitorPlugin(name = "CallService")
public class CallServicePlugin extends Plugin {
    private static CallServicePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void emitHangup() {
        CallServicePlugin p = instance;
        if (p != null) p.notifyListeners("hangup", new JSObject(), true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission not granted");
            return;
        }
        // Android 13+: ask once so the "call in progress" notification is visible (the service works either way).
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4514);
        }
        Intent intent = new Intent(ctx, CallService.class)
            .setAction(CallService.ACTION_START)
            .putExtra(CallService.EXTRA_TITLE, call.getString("title", "Call"))
            .putExtra(CallService.EXTRA_VIDEO, Boolean.TRUE.equals(call.getBoolean("video", false)));
        try {
            // The call is started from the visible app, so a normal start is allowed; the service
            // then promotes itself to the foreground with the microphone/camera service types.
            ctx.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start the call service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, CallService.class));
        call.resolve();
    }
}
