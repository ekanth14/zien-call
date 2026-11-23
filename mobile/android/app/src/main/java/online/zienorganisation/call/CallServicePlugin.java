package online.zienorganisation.call;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS bridge for calls in the Android app (Built by Zien Technologies).
 *
 * Methods (Capacitor.nativePromise('CallService', name, options)):
 *   start({ title, video, pip, mic })  call connected: foreground service, audio route, picture-in-picture
 *   update({ mic, video, pip })        mic/camera toggled or PiP setting changed
 *   stop()                             call ended
 *   getAudioRoutes() / setAudioRoute({ id }) / requestBluetooth()
 * Events (Capacitor.addListener('CallService', name, cb)):
 *   hangup, toggleMic (notification / PiP buttons), pip { active }, audioRoutes { routes, current }
 */
@CapacitorPlugin(
    name = "CallService",
    permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class CallServicePlugin extends Plugin {
    private static CallServicePlugin instance;
    private AudioRouter router;

    @Override
    public void load() {
        instance = this;
        router = new AudioRouter(getContext(), state -> notifyListeners("audioRoutes", state));
    }

    static void emitHangup() {
        CallServicePlugin p = instance;
        if (p != null) p.notifyListeners("hangup", new JSObject(), true);
    }

    static void emitToggleMic() {
        CallServicePlugin p = instance;
        if (p != null) p.notifyListeners("toggleMic", new JSObject(), true);
    }

    static void emitPip(boolean active) {
        CallServicePlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("active", active);
        p.notifyListeners("pip", o, true);
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
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        boolean pip = Boolean.TRUE.equals(call.getBoolean("pip", true));
        boolean mic = Boolean.TRUE.equals(call.getBoolean("mic", true));
        Intent intent = new Intent(ctx, CallService.class)
            .setAction(CallService.ACTION_START)
            .putExtra(CallService.EXTRA_TITLE, call.getString("title", "Call"))
            .putExtra(CallService.EXTRA_VIDEO, video);
        try {
            // The call is started from the visible app, so a normal start is allowed; the service
            // then promotes itself to the foreground with the microphone/camera service types.
            ctx.startService(intent);
        } catch (Exception e) {
            call.reject("Could not start the call service: " + e.getMessage());
            return;
        }
        if (!router.isActive()) router.begin(video); else router.setVideo(video);
        MainActivity.setCallState(getActivity(), true, pip, mic);
        call.resolve(router.state());
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (call.getBoolean("video") != null) router.setVideo(Boolean.TRUE.equals(call.getBoolean("video")));
        MainActivity.updateCallState(getActivity(), call.getBoolean("pip"), call.getBoolean("mic"));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, CallService.class));
        router.end();
        MainActivity.setCallState(getActivity(), false, false, true);
        call.resolve();
    }

    @PluginMethod
    public void getAudioRoutes(PluginCall call) {
        call.resolve(withPermission(router.state()));
    }

    @PluginMethod
    public void setAudioRoute(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("id required"); return; }
        router.select(id);
        call.resolve(withPermission(router.state()));
    }

    @PluginMethod
    public void requestBluetooth(PluginCall call) {
        if (Build.VERSION.SDK_INT < 31 || getPermissionState("bluetooth") == PermissionState.GRANTED) {
            router.refresh();
            call.resolve(withPermission(router.state()));
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothResult");
    }

    @PermissionCallback
    private void bluetoothResult(PluginCall call) {
        router.refresh();
        call.resolve(withPermission(router.state()));
    }

    private JSObject withPermission(JSObject state) {
        String bt = Build.VERSION.SDK_INT < 31 ? "granted" : getPermissionState("bluetooth").toString();
        state.put("bluetoothPermission", bt);
        return state;
    }

    @Override
    protected void handleOnDestroy() {
        if (router != null && router.isActive()) router.end();
        super.handleOnDestroy();
    }
}
