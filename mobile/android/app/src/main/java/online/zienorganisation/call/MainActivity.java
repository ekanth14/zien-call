package online.zienorganisation.call;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keeps calls running in the background (foreground service + notification).
        registerPlugin(CallServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
