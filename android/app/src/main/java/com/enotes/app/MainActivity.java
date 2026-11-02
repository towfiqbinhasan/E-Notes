package com.enotes.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        // S Pen strokes must reach the page as Pointer Events (pointerType "pen" + pressure).
        // Android 13+ may otherwise grab stylus input for "handwriting to text".
        if (Build.VERSION.SDK_INT >= 33) {
            webView.setAutoHandwritingEnabled(false);
        }
        // Pages are scrolled/zoomed by the app itself (finger = scroll, pen = ink).
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
    }
}
