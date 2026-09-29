package com.adam.injectiontracker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppLockPlugin.class);
        registerPlugin(GoogleDrivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
