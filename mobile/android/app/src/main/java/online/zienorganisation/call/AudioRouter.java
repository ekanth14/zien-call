package online.zienorganisation.call;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Chooses where call audio plays: earpiece, loudspeaker, Bluetooth or wired headset.
 *
 * Android 12+ uses AudioManager.setCommunicationDevice(); older versions use the
 * speakerphone / Bluetooth SCO switches. New headsets take over automatically (like a phone
 * call); if the active device disappears, audio falls back to the call's default route.
 * Built by Zien Technologies.
 */
class AudioRouter {
    interface Listener { void onChange(JSObject state); }

    static final String EARPIECE = "earpiece";
    static final String SPEAKER = "speaker";
    static final String BLUETOOTH = "bluetooth";
    static final String WIRED = "wired";

    private static final String TAG = "ZienAudioRouter";

    private final Context ctx;
    private final AudioManager am;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean active = false;
    private String defaultRoute = EARPIECE;
    private String chosen = null;      // what the user picked, if anything
    private String applied = null;     // last route we applied (used on Android < 12)
    private Object deviceCallback;     // AudioDeviceCallback (API 23+)
    private PowerManager.WakeLock proximity;

    AudioRouter(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.am = (AudioManager) this.ctx.getSystemService(Context.AUDIO_SERVICE);
        this.listener = listener;
    }

    /** Call started: audio calls default to the earpiece, video calls to the loudspeaker. */
    void begin(boolean video) {
        active = true;
        defaultRoute = video ? SPEAKER : EARPIECE;
        chosen = null;
        try { am.setMode(AudioManager.MODE_IN_COMMUNICATION); } catch (Exception e) { Log.w(TAG, "setMode: " + e); }
        registerCallback();
        applyBest();
        // The web view's WebRTC stack may pick its own route when the microphone opens; re-apply ours.
        main.postDelayed(this::reapply, 900);
        main.postDelayed(this::reapply, 2500);
    }

    void end() {
        active = false;
        chosen = null;
        main.removeCallbacksAndMessages(null);
        unregisterCallback();
        setProximity(false);
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice();
            } else {
                am.setSpeakerphoneOn(false);
                am.setBluetoothScoOn(false);
                am.stopBluetoothSco();
            }
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception e) {
            Log.w(TAG, "end: " + e);
        }
        applied = null;
    }

    boolean isActive() { return active; }

    /** Video toggled during a call: change the default (only if the user hasn't picked a route). */
    void setVideo(boolean video) {
        defaultRoute = video ? SPEAKER : EARPIECE;
        if (active && chosen == null) applyBest();
    }

    void select(String id) {
        if (!active) return;
        if (!available(id)) { notifyChange(); return; }   // e.g. no earpiece on this device
        chosen = id;
        apply(id);
        notifyChange();
    }

    void refresh() {
        if (active) applyBest(); else notifyChange();
    }

    private void reapply() {
        if (!active) return;
        String target = current();
        String want = chosen != null && available(chosen) ? chosen : best();
        if (want != null && !want.equals(target)) apply(want);
        notifyChange();
    }

    private void applyBest() {
        String want = chosen != null && available(chosen) ? chosen : best();
        if (want != null) apply(want);
        notifyChange();
    }

    /** Headset first, then the call's default, then whatever exists. */
    private String best() {
        if (available(BLUETOOTH)) return BLUETOOTH;
        if (available(WIRED)) return WIRED;
        if (available(defaultRoute)) return defaultRoute;
        if (available(SPEAKER)) return SPEAKER;
        return available(EARPIECE) ? EARPIECE : null;
    }

    private boolean available(String id) {
        for (Route r : routes()) if (r.id.equals(id)) return true;
        return false;
    }

    // ---------- device discovery ----------

    static final class Route {
        final String id; final String name; final AudioDeviceInfo device;
        Route(String id, String name, AudioDeviceInfo device) { this.id = id; this.name = name; this.device = device; }
    }

    private static String kindOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return EARPIECE;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return SPEAKER;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET: return WIRED;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_HEARING_AID: return BLUETOOTH;
            default: return null;
        }
    }

    private static String label(String id, AudioDeviceInfo d) {
        if (BLUETOOTH.equals(id) && d != null && d.getProductName() != null) {
            String n = d.getProductName().toString().trim();
            if (!n.isEmpty() && !n.equalsIgnoreCase(Build.MODEL)) return n;
        }
        switch (id) {
            case EARPIECE: return "Phone earpiece";
            case SPEAKER: return "Speaker";
            case WIRED: return "Wired headset";
            default: return "Bluetooth";
        }
    }

    List<Route> routes() {
        List<Route> out = new ArrayList<>();
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    String id = kindOf(d.getType());
                    if (id != null && !contains(out, id)) out.add(new Route(id, label(id, d), d));
                }
            } else {
                if (ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) out.add(new Route(EARPIECE, label(EARPIECE, null), null));
                out.add(new Route(SPEAKER, label(SPEAKER, null), null));
                if (Build.VERSION.SDK_INT >= 23) {
                    for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                        String id = kindOf(d.getType());
                        if ((WIRED.equals(id) || (BLUETOOTH.equals(id) && d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO)) && !contains(out, id)) {
                            out.add(new Route(id, label(id, d), d));
                        }
                    }
                } else if (am.isWiredHeadsetOn()) {
                    out.add(new Route(WIRED, label(WIRED, null), null));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "routes: " + e);
        }
        // fixed order: earpiece, speaker, wired, bluetooth
        List<Route> sorted = new ArrayList<>();
        for (String id : new String[] { EARPIECE, SPEAKER, WIRED, BLUETOOTH }) for (Route r : out) if (r.id.equals(id)) sorted.add(r);
        return sorted;
    }

    private static boolean contains(List<Route> list, String id) {
        for (Route r : list) if (r.id.equals(id)) return true;
        return false;
    }

    String current() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo d = am.getCommunicationDevice();
                return d != null ? kindOf(d.getType()) : null;
            }
        } catch (Exception e) {
            Log.w(TAG, "current: " + e);
        }
        return applied;
    }

    // ---------- switching ----------

    private void apply(String id) {
        boolean ok = false;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                for (Route r : routes()) {
                    if (r.id.equals(id) && r.device != null) {
                        ok = am.setCommunicationDevice(r.device);
                        if (!ok) Log.w(TAG, "setCommunicationDevice refused " + id);
                        break;
                    }
                }
            } else {
                if (BLUETOOTH.equals(id)) {
                    am.setSpeakerphoneOn(false);
                    am.startBluetoothSco();
                    am.setBluetoothScoOn(true);
                } else {
                    am.setBluetoothScoOn(false);
                    am.stopBluetoothSco();
                    am.setSpeakerphoneOn(SPEAKER.equals(id));
                }
                ok = true;
            }
            if (ok) applied = id;
        } catch (Exception e) {
            Log.w(TAG, "apply " + id + ": " + e);
        }
        // Turn the screen off when the phone is held to the ear (only if the earpiece is really in use).
        setProximity(EARPIECE.equals(current()));
    }

    private void setProximity(boolean on) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null || !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
            if (proximity == null) {
                proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "ZienCall:proximity");
                proximity.setReferenceCounted(false);
            }
            if (on && !proximity.isHeld()) proximity.acquire(4 * 60 * 60 * 1000L);
            if (!on && proximity.isHeld()) proximity.release();
        } catch (Exception e) {
            Log.w(TAG, "proximity: " + e);
        }
    }

    // ---------- headset plug / Bluetooth connect events ----------

    private void registerCallback() {
        if (Build.VERSION.SDK_INT < 23 || deviceCallback != null) return;
        AudioDeviceCallback cb = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                boolean headset = false;
                for (AudioDeviceInfo d : added) {
                    String k = kindOf(d.getType());
                    if (BLUETOOTH.equals(k) || WIRED.equals(k)) headset = true;
                }
                if (headset) chosen = null;   // a newly connected headset takes over, like a phone call
                main.postDelayed(AudioRouter.this::applyBest, 600);
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                main.postDelayed(() -> {
                    if (chosen != null && !available(chosen)) chosen = null;
                    applyBest();
                }, 600);
            }
        };
        am.registerAudioDeviceCallback(cb, main);
        deviceCallback = cb;
    }

    private void unregisterCallback() {
        if (Build.VERSION.SDK_INT < 23 || deviceCallback == null) return;
        am.unregisterAudioDeviceCallback((AudioDeviceCallback) deviceCallback);
        deviceCallback = null;
    }

    // ---------- state for the web app ----------

    JSObject state() {
        JSObject s = new JSObject();
        JSArray list = new JSArray();
        String cur = current();
        for (Route r : routes()) {
            JSObject o = new JSObject();
            o.put("id", r.id);
            o.put("name", r.name);
            o.put("active", r.id.equals(cur));
            list.put(o);
        }
        s.put("routes", list);
        s.put("current", cur);
        s.put("inCall", active);
        return s;
    }

    private void notifyChange() {
        if (listener != null) listener.onChange(state());
    }
}
