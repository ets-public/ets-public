package com.adam.injectiontracker;

import android.view.WindowManager;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * App lock using the phone's own fingerprint / face / screen lock (PIN, pattern, password).
 * JS: Capacitor.Plugins.AppLock.isAvailable(), .authenticate({title, subtitle}), .cancel(), .setSecure({enabled})
 *
 * Only one prompt runs at a time. Starting a new one cancels the old prompt and rejects its call,
 * so a prompt abandoned by leaving the app can never leave the lock screen stuck.
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {

    // Weak biometrics OR the device credential is supported on every Android version the app runs on.
    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private BiometricPrompt current;
    private PluginCall pending;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int r = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        String reason;
        if (r == BiometricManager.BIOMETRIC_SUCCESS) reason = "ok";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) reason = "none_enrolled";
        else if (r == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE || r == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) reason = "no_hardware";
        else reason = "unavailable";
        JSObject ret = new JSObject();
        ret.put("available", r == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    /** Cancels the running prompt (if any) and rejects its call as cancelled. Runs on the UI thread. */
    private void cancelCurrent() {
        if (current != null) {
            try { current.cancelAuthentication(); } catch (Exception ignored) {}
            current = null;
        }
        if (pending != null) {
            PluginCall old = pending;
            pending = null;
            old.reject("Cancelled", "5");
        }
    }

    @PluginMethod
    public void cancel(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cancelCurrent();
            call.resolve();
        });
    }

    @PluginMethod
    public void authenticate(final PluginCall call) {
        final String title = call.getString("title", "Unlock");
        final String subtitle = call.getString("subtitle", "");
        getActivity().runOnUiThread(() -> {
            cancelCurrent();
            pending = call;
            try {
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setSubtitle(subtitle)
                        .setAllowedAuthenticators(AUTHENTICATORS)
                        .build();
                final BiometricPrompt[] self = new BiometricPrompt[1];
                self[0] = new BiometricPrompt(getActivity(),
                        ContextCompat.getMainExecutor(getContext()),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                if (current == self[0]) current = null;
                                if (pending == call) pending = null;
                                JSObject ret = new JSObject();
                                ret.put("ok", true);
                                call.resolve(ret);
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                if (current == self[0]) current = null;
                                if (pending == call) {
                                    pending = null;
                                    call.reject(String.valueOf(errString), String.valueOf(errorCode));
                                }
                                // otherwise this call was already rejected when a newer prompt replaced it
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // A finger that didn't match: the prompt stays open for another try.
                            }
                        });
                current = self[0];
                current.authenticate(info);
            } catch (Exception e) {
                current = null;
                if (pending == call) pending = null;
                call.reject(e.getMessage() != null ? e.getMessage() : "Authentication unavailable");
            }
        });
    }

    /** FLAG_SECURE hides the app in the recent-apps view and blocks screenshots. */
    @PluginMethod
    public void setSecure(final PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }
}
