import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // TODO when publishing: io.github.<github-user>.inkwrap (changing it makes a new app on the phone)
  appId: 'io.github.flowread',
  appName: 'Inkwrap',
  webDir: 'dist',
  android: {
    // PDFs are opened from local files only; no network access is needed at runtime
    allowMixedContent: false,
  },
};

export default config;
