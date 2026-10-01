package com.adam.injectiontracker;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

/**
 * Read-only bridge for the companion home-screen launcher.
 *
 * The web app writes a small JSON "today" summary to Capacitor Preferences (key ets-launcher-summary) only when
 * the user turns on Setup > Home-screen launcher; otherwise the value is empty. This provider hands that one value
 * to apps holding READ_LAUNCHER_SUMMARY, a runtime ("dangerous") permission the user has to allow, and tells them
 * when it changes. It never reads the main database.
 *
 *   content://com.adam.injectiontracker.launcher/summary  ->  one row, column "json" ("" = sharing is off)
 */
public class LauncherSummaryProvider extends ContentProvider implements SharedPreferences.OnSharedPreferenceChangeListener {

    static final String AUTHORITY = "com.adam.injectiontracker.launcher";
    static final Uri SUMMARY = Uri.parse("content://" + AUTHORITY + "/summary");
    private static final String PREFS = "CapacitorStorage";      // @capacitor/preferences' default group
    private static final String KEY = "ets-launcher-summary";

    private SharedPreferences prefs;

    @Override
    public boolean onCreate() {
        Context ctx = getContext();
        if (ctx == null) return false;
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.registerOnSharedPreferenceChangeListener(this);
        return true;
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences p, String key) {
        Context ctx = getContext();
        if (ctx != null && KEY.equals(key)) ctx.getContentResolver().notifyChange(SUMMARY, null);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        MatrixCursor cursor = new MatrixCursor(new String[] { "json" });
        String json = prefs != null ? prefs.getString(KEY, "") : "";
        cursor.addRow(new Object[] { json == null ? "" : json });
        Context ctx = getContext();
        if (ctx != null) cursor.setNotificationUri(ctx.getContentResolver(), SUMMARY);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.item/vnd.com.adam.injectiontracker.summary";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }
}
