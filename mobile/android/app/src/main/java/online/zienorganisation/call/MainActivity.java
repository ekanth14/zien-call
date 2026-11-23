package online.zienorganisation.call;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.Rational;

import androidx.annotation.RequiresApi;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "ZienMainActivity";

    // Call state shared with CallServicePlugin (single activity, main thread updates).
    private static volatile boolean callActive = false;
    private static volatile boolean pipEnabled = true;
    private static volatile boolean micOn = true;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keeps calls running in the background (foreground service, audio routes, picture-in-picture).
        registerPlugin(CallServicePlugin.class);
        super.onCreate(savedInstanceState);
    }

    static void setCallState(Activity a, boolean active, boolean pip, boolean mic) {
        callActive = active;
        pipEnabled = pip;
        micOn = mic;
        refresh(a);
    }

    static void updateCallState(Activity a, Boolean pip, Boolean mic) {
        if (pip != null) pipEnabled = pip;
        if (mic != null) micOn = mic;
        refresh(a);
    }

    private static void refresh(Activity a) {
        if (a instanceof MainActivity) a.runOnUiThread(((MainActivity) a)::refreshPipParams);
    }

    private void refreshPipParams() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            setPictureInPictureParams(buildPipParams());
        } catch (Exception e) {
            Log.w(TAG, "setPictureInPictureParams: " + e);
        }
    }

    @RequiresApi(26)
    private PictureInPictureParams buildPipParams() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4));
        List<RemoteAction> actions = new ArrayList<>();
        if (callActive) {
            actions.add(pipAction(micOn ? R.drawable.ic_pip_mic : R.drawable.ic_pip_mic_off,
                micOn ? "Mute" : "Unmute", CallService.ACTION_TOGGLE_MIC, 2));
            actions.add(pipAction(R.drawable.ic_pip_call_end, "Hang up", CallService.ACTION_HANGUP, 3));
        }
        b.setActions(actions);
        if (Build.VERSION.SDK_INT >= 31) {
            // Android 12+: go into the floating window smoothly when the user leaves the app mid-call.
            b.setAutoEnterEnabled(callActive && pipEnabled);
            b.setSeamlessResizeEnabled(true);
        }
        return b.build();
    }

    @RequiresApi(26)
    private RemoteAction pipAction(int icon, String title, String action, int requestCode) {
        Intent i = new Intent(this, CallService.class).setAction(action);
        PendingIntent pi = PendingIntent.getService(this, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new RemoteAction(Icon.createWithResource(this, icon), title, title, pi);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Android 8-11: enter the floating window when Home / app switch is pressed during a call.
        if (callActive && pipEnabled && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) {
            try {
                enterPictureInPictureMode(buildPipParams());
            } catch (Exception e) {
                Log.w(TAG, "enterPictureInPictureMode: " + e);
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        CallServicePlugin.emitPip(isInPictureInPictureMode);
    }
}
