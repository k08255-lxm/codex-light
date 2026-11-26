package com.codexlight.android;

import android.content.Context;
import android.content.res.Configuration;

final class DeviceAppearance {
    static String theme(Context context) {
        return context.getSharedPreferences("appearance",Context.MODE_PRIVATE).getString("theme","");
    }

    static void save(Context context,String choice) {
        if ("system".equals(choice) || "light".equals(choice) || "dark".equals(choice))
            context.getSharedPreferences("appearance",Context.MODE_PRIVATE).edit().putString("theme",choice).apply();
    }

    static Context apply(Context base) {
        String choice=theme(base);
        if (!"light".equals(choice) && !"dark".equals(choice)) return base;
        Configuration config=new Configuration(base.getResources().getConfiguration());
        int mode="dark".equals(choice) ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO;
        config.uiMode=(config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | mode;
        return base.createConfigurationContext(config);
    }
}
